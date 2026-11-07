import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { AccountSummary, OperationRequest } from "@/lib/contracts";
import { createJobStore, JobError, LeaseLostError } from "@/server/jobs/store";

const handles:Database.Database[]=[];
const directories:{directory:string;base:string}[]=[];
const account:AccountSummary={id:"account-a",name:"Test account",tenancyId:"tenancy",userId:"user",fingerprint:"fp",
  homeRegion:"region-a",regions:["region-a"],status:"connected",lastSyncAt:null,lastError:null,createdAt:"2026-01-01T00:00:00.000Z"};
function fixture(){
  const base=resolve(process.env.OCI_DASH_TEST_TMP||join(process.cwd(),".test-tmp"));mkdirSync(base,{recursive:true});
  const directory=mkdtempSync(join(base,"oci-dash-jobs-test-"));directories.push({directory,base});
  const path=join(directory,"jobs.sqlite");let time=Date.parse("2026-01-01T00:00:00Z");
  const now=()=>new Date(time);
  const open=()=>{const db=new Database(path);db.pragma("journal_mode=WAL");db.pragma("busy_timeout=5000");handles.push(db);
    return {db,store:createJobStore({db,getAccount:id=>id===account.id?account:null,now})};};
  return {path,open,advance:(ms:number)=>{time+=ms;},...open()};
}
const operation=(resourceId="instance-1",payload:Record<string,unknown>={}):OperationRequest=>({kind:"instance-rename",accountId:account.id,region:"region-a",resourceId,payload});
afterEach(()=>{
  for(const db of handles.splice(0))if(db.open)db.close();
  for(const {directory,base} of directories.splice(0)){
    const target=resolve(directory);
    if(dirname(target)!==base||!basename(target).startsWith("oci-dash-jobs-test-"))throw Error("Unsafe test cleanup path");
    rmSync(target,{recursive:true,force:true});
  }
});

describe("durable job store",()=>{
  it("deduplicates the same request across a database reopen and rejects different payloads",()=>{
    const f=fixture();
    const first=f.store.enqueueOperation({...operation("instance-1",{name:"new",nested:{b:2,a:1}}),idempotencyKey:"request-1"},"admin");
    f.db.close();const reopened=f.open();
    const duplicate=reopened.store.enqueueOperation({...operation("instance-1",{nested:{a:1,b:2},name:"new"}),idempotencyKey:"request-1"},"admin");
    expect(duplicate.id).toBe(first.id);expect(duplicate.attempt).toBe(0);
    expect(reopened.store.listJobs()).toHaveLength(1);
    expect(reopened.store.getJobEvents(first.id)).toHaveLength(1);
    expect(()=>reopened.store.enqueueOperation({...operation("instance-1",{name:"different"}),idempotencyKey:"request-1"},"admin"))
      .toThrow("different request");
  });

  it("atomically excludes another worker from the same resource but permits other resources",()=>{
    const f=fixture(),other=f.open();
    const first=f.store.enqueueOperation(operation(),"admin");f.advance(1);
    const blocked=f.store.enqueueOperation(operation(),"admin");f.advance(1);
    const independent=f.store.enqueueOperation(operation("instance-2"),"admin");
    expect(f.store.claimNext("worker-a")?.summary.id).toBe(first.id);
    expect(other.store.claimNext("worker-b")?.summary.id).toBe(independent.id);
    expect(other.store.claimNext("worker-c")).toBeNull();
    expect(f.store.getJob(blocked.id)?.attempt).toBe(0);
    f.store.finish(first.id,"worker-a","succeeded",{message:"renamed"});
    expect(other.store.claimNext("worker-c")?.summary.id).toBe(blocked.id);
  });

  it("serializes shared security groups even when the operations name different instances",()=>{
    const f=fixture(),other=f.open();
    const first=f.store.enqueueOperation({...operation("instance-1",{groupId:"shared-nsg"}),kind:"security-rule-add"},"admin");f.advance(1);
    const second=f.store.enqueueOperation({...operation("instance-2",{groupId:"shared-nsg"}),kind:"security-rule-delete"},"admin");
    expect(f.store.claimNext("a")?.summary.id).toBe(first.id);
    expect(other.store.claimNext("b")).toBeNull();
    f.store.finish(first.id,"a","succeeded");
    expect(other.store.claimNext("b")?.summary.id).toBe(second.id);
  });

  it("recovers expired leases with durable checkpoints and fences stale workers",()=>{
    const f=fixture(),other=f.open();
    const submitted=f.store.enqueueOperation({...operation(),kind:"public-ip-rotate"},"admin");
    f.store.claimNext("crashed-worker",1000);
    f.store.checkpoint(submitted.id,"crashed-worker","publicIpDeletion",{publicIpId:"old-ip",confirmed:true});
    f.advance(1001);
    const recovered=other.store.claimNext("replacement-worker",1000);
    expect(recovered?.summary.id).toBe(submitted.id);
    expect(recovered?.summary.attempt).toBe(2);
    expect(recovered?.needsReconcile).toBe(true);
    expect(recovered?.checkpoints.publicIpDeletion).toEqual({publicIpId:"old-ip",confirmed:true});
    expect(()=>f.store.finish(submitted.id,"crashed-worker","succeeded")).toThrow(LeaseLostError);
    expect(f.store.renewLease(submitted.id,"crashed-worker",1000)).toBe(false);
    expect(other.store.getJobEvents(submitted.id).some(e=>e.message.includes("lease expired"))).toBe(true);
  });

  it("keeps a running cancellation locked until acknowledged, while cancelling queued work immediately",()=>{
    const f=fixture();
    const running=f.store.enqueueOperation(operation(),"admin");f.advance(1);
    const waiting=f.store.enqueueOperation(operation(),"admin");
    f.store.claimNext("a");
    expect(f.store.cancelJob(running.id).state).toBe("cancel_requested");
    expect(f.store.claimNext("b")).toBeNull();
    expect(f.store.cancelJob(waiting.id).state).toBe("cancelled");
    expect(f.store.getJob(waiting.id)?.attempt).toBe(0);
    f.store.finish(running.id,"a","cancelled");
    expect(f.store.getJob(running.id)?.state).toBe("cancelled");
    expect(f.store.getJobEvents(running.id).some(e=>e.message.includes("not rolled back"))).toBe(true);
  });

  it("bounds automatic retries without resetting actual attempt counts on manual retry",()=>{
    const f=fixture();const job=f.store.enqueueOperation(operation(),"admin");
    for(let attempt=1;attempt<=4;attempt++){
      expect(f.store.claimNext("a")?.summary.attempt).toBe(attempt);
      f.store.retryLater(job.id,"a","Temporary OCI error",100);
      if(attempt<4){expect(f.store.claimNext("a")).toBeNull();f.advance(100);}
    }
    expect(f.store.getJob(job.id)).toMatchObject({state:"failed",attempt:4,maxAttempts:4});
    expect(f.store.claimNext("a")).toBeNull();
    expect(f.store.retryJob(job.id)).toMatchObject({state:"queued",attempt:4,maxAttempts:8});
    expect(f.store.claimNext("a")?.summary.attempt).toBe(5);
  });

  it("refuses secrets in operations and checkpoints and redacts event details",()=>{
    const f=fixture();
    expect(()=>f.store.enqueueOperation(operation("instance-1",{privateKey:"never-store-me"}),"admin")).toThrow(JobError);
    const job=f.store.enqueueOperation(operation(),"admin");f.store.claimNext("a");
    expect(()=>f.store.checkpoint(job.id,"a","cloudResponse",{privateKey:"never-store-me"})).toThrow(JobError);
    f.store.progress(job.id,"a","Response summary",{authorization:"Bearer never-store-me",resourceId:"public-id"});
    expect(JSON.stringify(f.store.getJobEvents(job.id))).not.toContain("never-store-me");
    expect(f.store.getJobEvents(job.id).at(-1)?.detail).toEqual({authorization:"[REDACTED]",resourceId:"public-id"});
  });

  it("reports live workers without a stopped worker hiding another heartbeat",()=>{
    const f=fixture();f.store.heartbeat("live");f.advance(1);f.store.heartbeat("stopped");f.store.stopWorker("stopped");
    expect(f.store.getWorkerStatus()).toMatchObject({online:true,workerId:"live",activeJobs:0});
    f.advance(30_001);expect(f.store.getWorkerStatus().online).toBe(false);
  });
});
