import { Context } from "effect";
import type { ApiEnv } from "./env";

export class WorkerEnv extends Context.Service<WorkerEnv, ApiEnv>()("router/WorkerEnv") {}

export class WorkerExecution extends Context.Service<WorkerExecution, ExecutionContext>()("router/WorkerExecution") {}
