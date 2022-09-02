import * as errors from './errors';
import * as entity from '../entity';
import * as jobQueue from '../job-queue';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { Job } from 'bullmq';
import util from 'util';
import path from 'path';
import { getClient } from '../cache';
import { ExecException, exec as _exec } from 'child_process';

const exec = util.promisify(_exec);

export class CodeExecutionService {

    private static instance: CodeExecutionService;
    private static hasAddedWorker = false;
    private supportedLanguages = new Set(["c", "cpp", "python", "java"]);
    private constructor() {}

     // follows the singleton pattern
    public static getInstance(): CodeExecutionService {

        if (!CodeExecutionService.instance) {
            CodeExecutionService.instance = new CodeExecutionService();
        }

        if (!CodeExecutionService.hasAddedWorker) {
            jobQueue.addWorker(CodeExecutionService.instance.job);
            CodeExecutionService.hasAddedWorker = true;
        }

        return CodeExecutionService.instance;
    }

    public runCode(codeExecutionInput: entity.CodeExecutionInput) {
        try {
            if (!this.supportedLanguages.has(codeExecutionInput.language)) {
                throw new errors.ErrUnsupportedLanguage;
            }
            // appending the "job-" prefix to the uuid can help
            // in differentiating the uuid from our session-ids during debugging
            const jobId = `job-${uuidv4()}`;
            jobQueue.addJob(jobId, codeExecutionInput);
            return jobId;
        } catch (err) {
            throw err;
        }
    }

    public job = async(job: Job) => {

        const data: entity.CodeExecutionInput = job.data;
        const executionAreaPath = `./execution-area`;
        const directoryPath = `${executionAreaPath}/${job.id}`;
        const submissionFilePath = `${directoryPath}/${this.getFileName(data.language)}`;
        const inputFilePath = `${directoryPath}/input.txt`;
        const expectedOutputFilePath = `${directoryPath}/output.txt`;
        const actualOutputFilePath = `${directoryPath}/submission.txt`;

        // control time limit and memory limit
        data.timeLimit = Math.min(data.timeLimit, 10); // 10 seconds
        data.memoryLimit = Math.min(data.memoryLimit, 1024); // 1GB

        // setup directory
        try {
            await job.updateProgress(entity.CodeExecutionProgress.START)
            await fs.promises.mkdir(directoryPath);
            await fs.promises.writeFile(submissionFilePath, data.code, {
                encoding: 'utf-8'
            });
            await fs.promises.writeFile(inputFilePath, 
                (data.executionType === 'judge')
                ? this.getFileContent(data.testCases, true)
                : data.inputForRun, {
                encoding: 'utf-8'
            });
            await fs.promises.writeFile(expectedOutputFilePath, this.getFileContent(data.testCases, false), {
                encoding: 'utf-8'
            });
            await job.updateProgress(entity.CodeExecutionProgress.MKDIR);
        } catch (err) {
            console.log(err);
            throw errors.ErrJobMkdir;
        }

        // create container with a mounted directory with memory limit, time limit and no network support
        try {
            await exec(`docker create -m ${data.memoryLimit}m --memory-swap ${data.memoryLimit}m --network none -e TIME_LIMIT=${data.timeLimit} --name ${job.id} -v ${path.resolve(directoryPath)}:/ae assignexpert-${data.language}`);
            await job.updateProgress(entity.CodeExecutionProgress.DOCKER_CREATE)
        } catch (err) {
            console.log(err);
            throw errors.ErrNoContainerCreate;
        }

        const codeExecutionOutput: entity.CodeExecutionOutput = {
            timeTaken: 0,
            memoryUsed: 0,
            resultStatus: entity.ResultStatus.CE,
            resultMessage: ''
        };

        // run the container, check for {CE, RE, TLE, MLE, WA, AC}, 
        // compute stats, store result in cache
        try {
            await exec(`docker start -a ${job.id}`);
            await job.updateProgress(entity.CodeExecutionProgress.DOCKER_START);

            const compilationFileContent = await fs.promises.readFile(`${directoryPath}/compile.txt`, {
                encoding: 'utf-8'
            });
            if (compilationFileContent !== "") {
                codeExecutionOutput.resultStatus = entity.ResultStatus.CE;
                codeExecutionOutput.resultMessage = compilationFileContent;
                throw errors.ErrCodeCompileError;
            }

            const runtimeFileContent = await fs.promises.readFile(`${directoryPath}/runtime.txt`, {
                encoding: 'utf-8'
            });
            if (runtimeFileContent !== "") {
                codeExecutionOutput.resultStatus = entity.ResultStatus.RE;
                codeExecutionOutput.resultMessage = runtimeFileContent;
                throw errors.ErrRuntimeError;
            }

            const timeoutFileContent = await fs.promises.readFile(`${directoryPath}/timeout.txt`, {
                encoding: 'utf-8'
            });
            if (timeoutFileContent !== "0\n") {
                codeExecutionOutput.resultStatus = entity.ResultStatus.TLE;
                codeExecutionOutput.resultMessage = "Time limit exceeded.";
                throw errors.ErrTimeLimitExceeded;
            }

            if (data.executionType === 'judge') {
                const diff = await this.processOutputs(actualOutputFilePath, expectedOutputFilePath);
                if (diff !== "") {
                    codeExecutionOutput.resultStatus = entity.ResultStatus.WA;
                    codeExecutionOutput.resultMessage = diff;
                } else {
                    codeExecutionOutput.resultStatus = entity.ResultStatus.AC;
                    codeExecutionOutput.resultMessage = "";
                }
            } else {
                const output = await fs.promises.readFile(actualOutputFilePath, {
                    encoding: 'utf-8'
                });
                codeExecutionOutput.resultStatus = entity.ResultStatus.AC;
                codeExecutionOutput.resultMessage = output;
            }

            const statsFileContent = await fs.promises.readFile(`${directoryPath}/stats.txt`, {
                encoding: 'utf-8'
            });
            const stats = statsFileContent.split("-");
            codeExecutionOutput.memoryUsed = parseFloat(stats[0]);
            codeExecutionOutput.timeTaken = parseFloat(stats[1]);
            await job.updateProgress(entity.CodeExecutionProgress.COMPUTE_RESULT);
        } catch (err) {
            console.log(err);
            if (this.isExecException(err)) {
                const MLE_CODE = 137;
                if (err.code === MLE_CODE) {
                    codeExecutionOutput.resultStatus = entity.ResultStatus.MLE;
                    codeExecutionOutput.resultMessage = "Memory limit exceeded."
                }
            }
        } finally {
            await this.setResultInCache(job.id || job.name, codeExecutionOutput);
        }

        // destory the container and the directory
        try {
            await exec(`docker rm ${job.id}`);
            await fs.promises.rm(directoryPath, {
                recursive: true,
                force: true
            });
            await job.updateProgress(entity.CodeExecutionProgress.CLEAN);
        } catch (err) {
            throw err;
        }
    }

    public async getJobResult(jobId: string): Promise<entity.CodeExecutionOutput | undefined> {
        try {
            const cacheClient = getClient();
            if (!cacheClient.isOpen) {
                await cacheClient.connect();
            }
            const data = await cacheClient.get(jobId);
            if (data === undefined || data === null) {
                return undefined;
            }
            return JSON.parse(data);
        } catch (err) {
            throw err;
        }
    }

    private async setResultInCache(jobId: string, data: entity.CodeExecutionOutput) {
        try {
            const cacheClient = getClient();
            if (!cacheClient.isOpen) {
                await cacheClient.connect();
            }
            await cacheClient.set(jobId, JSON.stringify(data));
        } catch (err) {
            throw err;
        }
    }
    
    private getFileName(language: string): string {
        if (language === "python") {
            return "submission.py";
        }
        if (language === "java") {
            return "Submission.java";
        }
        return `submission.${language}`;
    }

    private getFileContent(testCases: entity.TestCase[], writeInput: boolean): string {
        let result = (writeInput) ? `${testCases.length}\n` : "";
        for (let i = 0; i < testCases.length; ++i) {
            result += (writeInput) ? `${testCases[i].input}\n` : `${testCases[i].output}\n`;
        }
        return result;
    }

    private async processOutputs(actualOutputFile: string, expectedOutputFile: string): Promise<string> {
        try {
            const { stdout } = await exec(`diff ${actualOutputFile} ${expectedOutputFile} 2>&1`);
            return stdout;
        } catch (err) {
            if (this.isExecException(err)) {
                return err.message;
            }
            return "";
        }
        
    }

    private isExecException(object: unknown): object is ExecException {
        return Object.prototype.hasOwnProperty.call(object, "code")
        && Object.prototype.hasOwnProperty.call(object, "killed")
        && Object.prototype.hasOwnProperty.call(object, "cmd")
    }
}