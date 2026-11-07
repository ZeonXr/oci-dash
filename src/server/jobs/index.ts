import type { OperationRequest } from "@/lib/contracts";
import { getDatabase } from "@/server/db";
import { getAccount } from "@/server/accounts";
import { createJobStore, type JobStore } from "./store";

const stores = new WeakMap<ReturnType<typeof getDatabase>, JobStore>();
export function getJobStore(): JobStore {
  const database = getDatabase();
  let store = stores.get(database);
  if (!store) {
    store = createJobStore({ db: database, getAccount });
    stores.set(database, store);
  }
  return store;
}
export const enqueueOperation = (operation: OperationRequest, requestedBy: string) =>
  getJobStore().enqueueOperation(operation, requestedBy);
export const listJobs = (limit?: number) => getJobStore().listJobs(limit);
export const getJob = (id: string) => getJobStore().getJob(id);
export const getJobEvents = (id: string) => getJobStore().getJobEvents(id);
export const cancelJob = (id: string) => getJobStore().cancelJob(id);
export const retryJob = (id: string) => getJobStore().retryJob(id);
export const getWorkerStatus = () => getJobStore().getWorkerStatus();
export { JobError, createJobStore, ensureJobSchema } from "./store";
export type { WorkerStatus, JobStore } from "./store";
export { runWorker } from "./worker";
export type { WorkerDependencies, RunWorkerOptions } from "./worker";
