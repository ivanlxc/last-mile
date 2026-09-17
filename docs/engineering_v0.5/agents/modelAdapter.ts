/** Design-reference adapter: no credentials are read and no request runs on import.
 * http_json is an explicitly defined gateway protocol, not a claim that every model
 * vendor implements it. A vendor adapter must map this protocol at the backend.
 */
export type AgentRole = 'advisor' | 'evaluator';
export type AttemptStatus = 'succeeded' | 'failed' | 'timeout' | 'unknown';
export interface ModelConfig {
  provider: 'http_json' | 'mock'; endpoint: string | null;
  advisorModel: string; evaluatorModel: string; apiKeyEnvName: string;
  promptVersion: '0.5'; schemaVersion: '0.5'; locale: 'zh-CN';
  advisorTimeoutMs: 8000; evaluatorTimeoutMs: 20000;
  advisorMaxOutputTokens: 1200; evaluatorMaxOutputTokens: 3000;
  supportsIdempotency: boolean; configurationId: string;
}
export interface StructuredRequest {
  role: AgentRole; model: string; systemPrompt: string; input: unknown;
  schema: object; requestKey: string; maxOutputTokens: number;
  timeoutMs: number; signal?: AbortSignal;
}
export interface ModelUsage { inputTokens: number; outputTokens: number; }
export type StructuredResult =
 | { ok: true; structured: unknown; usage: ModelUsage; providerRequestId: string | null; }
 | { ok: false; code: 'MODEL_TIMEOUT'|'MODEL_TRANSPORT'|'MODEL_RATE_LIMIT'|'MODEL_INVALID_OUTPUT';
     retryable: boolean; usage: ModelUsage | null; providerRequestId: string | null; };
export interface ModelAdapter { generateStructured(request: StructuredRequest): Promise<StructuredResult>; }

/** POST {model,messages,responseSchema,maxOutputTokens,idempotencyKey}.
 * Success response: {structured:object,usage:{inputTokens:int,outputTokens:int},requestId?:string}.
 * Error: HTTP429/5xx are potentially transient. No implicit retries.
 * Local orchestration owns attempt accounting BEFORE this call, all JSON Schema
 * validation, citation guards, current-input checks and output persistence AFTER.
 */
export class HttpJsonModelAdapter implements ModelAdapter {
  constructor(private endpoint: string, private apiKey: string, private supportsIdempotency: boolean) {
    const url = new URL(endpoint);
    const local = ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('HTTPS_REQUIRED');
  }
  async generateStructured(r: StructuredRequest): Promise<StructuredResult> {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (r.signal?.aborted) controller.abort();
    r.signal?.addEventListener('abort', abort, {once:true});
    const timer = setTimeout(() => { timedOut=true; controller.abort(); }, r.timeoutMs);
    try {
      const headers: Record<string,string> = {'Content-Type':'application/json','Authorization':`Bearer ${this.apiKey}`};
      if (this.supportsIdempotency) headers['Idempotency-Key']=r.requestKey;
      const response = await fetch(this.endpoint, {
        method:'POST',headers,signal:controller.signal,
        body:JSON.stringify({model:r.model,messages:[
          {role:'system',content:r.systemPrompt},
          {role:'user',content:JSON.stringify(r.input)}
        ],responseSchema:r.schema,maxOutputTokens:r.maxOutputTokens,idempotencyKey:r.requestKey})
      });
      if (!response.ok) return {ok:false,code:response.status===429?'MODEL_RATE_LIMIT':'MODEL_TRANSPORT',
        retryable:response.status===429||response.status>=500,usage:null,providerRequestId:null};
      const body: unknown = await response.json();
      if (!body || typeof body!=='object') return {ok:false,code:'MODEL_INVALID_OUTPUT',retryable:false,usage:null,providerRequestId:null};
      const b=body as {structured?:unknown;usage?:ModelUsage;requestId?:unknown};
      const u=b.usage;
      if (!b.structured || typeof b.structured!=='object' || !u ||
          !Number.isInteger(u.inputTokens) || u.inputTokens<0 || !Number.isInteger(u.outputTokens) || u.outputTokens<0)
        return {ok:false,code:'MODEL_INVALID_OUTPUT',retryable:false,usage:null,providerRequestId:null};
      return {ok:true,structured:b.structured,usage:u,providerRequestId:typeof b.requestId==='string'?b.requestId:null};
    } catch {
      return {ok:false,code:timedOut?'MODEL_TIMEOUT':'MODEL_TRANSPORT',retryable:timedOut||!r.signal?.aborted,usage:null,providerRequestId:null};
    } finally { clearTimeout(timer);r.signal?.removeEventListener('abort',abort); }
  }
}

/** Tests inject a function; a mock cannot secretly become a live call. */
export class MockModelAdapter implements ModelAdapter {
  constructor(private responder:(r:StructuredRequest)=>StructuredResult|Promise<StructuredResult>) {}
  async generateStructured(r:StructuredRequest):Promise<StructuredResult> { return this.responder(r); }
}
