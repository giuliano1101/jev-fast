import {performance} from 'node:perf_hooks';
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-1.14.0';
const LIMIT = 16 * 1024 * 1024;
const unit = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
function bounded(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(Error('PROVIDER_DEADLINE'));
    signal.addEventListener('abort', abort, {once:true});
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
/** Batched atomic questions share one state and one official round trip; no execution. */
export async function askQuestions({key, recorder, transport = fetch}, {state, questions, timeoutMs = 15000, signal:parent}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647 || !questions || typeof questions !== 'object' || Array.isArray(questions) || !Object.keys(questions).length) throw Error('INVALID_QUESTIONS');
  for (const question of Object.values(questions)) {
    if (!question || !['choice', 'noul'].includes(question.type) || question.instructions === undefined) throw Error('INVALID_QUESTIONS');
    if (question.type === 'choice' && (!question.criteria || typeof question.criteria !== 'object' || Array.isArray(question.criteria) || !Object.keys(question.criteria).length || Object.keys(question.criteria).length > 255)) throw Error('INVALID_QUESTIONS');
  }
  const body = JSON.stringify({model:MODEL, state, questions});
  if (Buffer.byteLength(body) > LIMIT) throw Error('REQUEST_TOO_LARGE');
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = AbortSignal.any([controller.signal, ...(parent ? [parent] : [])]);
  if (signal.aborted) {clearTimeout(timer); throw Error('CANCELLED');}
  let attempt, http_status = null, usage = null;
  const started = performance.now();
  try {
    attempt = recorder.begin();
    if (signal.aborted || Date.now() >= deadline) throw Error('PROVIDER_DEADLINE');
    const response = await bounded(transport(ENDPOINT, {method:'POST', redirect:'error', headers:{authorization:`Bearer ${key}`, 'content-type':'application/json'}, body, signal}), signal);
    http_status = response.status;
    const reader = response.body?.getReader(); let raw;
    if (reader) {
      const chunks = []; let bytes = 0;
      try {
        for (;;) { const part = await bounded(reader.read(), signal); if (part.done) break; bytes += part.value.byteLength; if (bytes > LIMIT) throw Error('RESPONSE_TOO_LARGE'); chunks.push(part.value); }
        try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('INVALID_RESPONSE'); }
      } finally { void reader.cancel().catch(() => {}); }
    }
    if (Number.isSafeInteger(raw?.usage?.input_tokens) && raw.usage.input_tokens >= 0 && Number.isSafeInteger(raw.usage.output_tokens) && raw.usage.output_tokens >= 0) usage = {input_tokens:raw.usage.input_tokens, output_tokens:raw.usage.output_tokens};
    if (!response.ok) throw Error(`PROVIDER_HTTP_${response.status}`);
    if (raw?.model !== MODEL || !raw.answers) throw Error('INVALID_RESPONSE');
    const answers = {};
    for (const [id, question] of Object.entries(questions)) {
      const answer = raw.answers[id];
      if (!answer || answer.type !== question.type) throw Error('INVALID_RESPONSE');
      if (question.type === 'noul') { if (!unit(answer.noul)) throw Error('INVALID_RESPONSE'); answers[id] = {type:'noul', noul:answer.noul}; continue; }
      const ids = Object.keys(question.criteria), probabilities = answer.probabilities;
      if (!ids.includes(answer.choice) || !unit(answer.confidence) || !probabilities || Object.keys(probabilities).length !== ids.length || ids.some(key => !unit(probabilities[key])) || Math.abs(Object.values(probabilities).reduce((sum,p) => sum+p, 0)-1) > 1e-5 || Object.values(probabilities).some(p => p > probabilities[answer.choice]+1e-9)) throw Error('INVALID_RESPONSE');
      answers[id] = {type:'choice', choice:answer.choice, confidence:answer.confidence, probabilities};
    }
    if (signal.aborted || Date.now() >= deadline) throw Error('PROVIDER_DEADLINE');
    return {provider:'jev', model:MODEL, answers, usage, elapsed_ms:performance.now()-started};
  } catch (error) {
    const code = String(error?.message);
    throw Error(/^[A-Z][A-Z0-9_]*$/.test(code) ? code : 'PROVIDER_UNAVAILABLE');
  } finally { try {if (attempt) recorder.finish(attempt, {http_status, usage});} finally {clearTimeout(timer);} if (Date.now() >= deadline) throw Error('PROVIDER_DEADLINE'); }
}
