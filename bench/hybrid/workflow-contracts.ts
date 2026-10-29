import {z} from 'zod';
export interface WorkflowCatalog {actionIds: readonly string[]; predicateIds: readonly string[]}
export interface ProcedureScope {
  applicationId:string; pageType:string; accountScope:string; language:string;
  environmentFingerprint:string; observerVersion:string;
}
export interface ProcedureStep {
  actionId:string; preconditions:string[]; postconditions:string[]; mayInvalidate:string[]; safeRepeat:boolean;
}
export interface ProcedureDefinition {
  schemaVersion:1; procedureId:string; scope:ProcedureScope; ttlMs:number; goalPredicates:string[]; steps:ProcedureStep[];
}
export type EvidenceTruth = boolean|'unknown';
export interface TrialEvidence {
  trialId:string; startStateKey:string; executor:'teacher'|'jev'|'direct'; completedAt:number;
  independentlyVerified:boolean; terminal:EvidenceTruth; actionUnknown:boolean; regression:EvidenceTruth;
  predicates:Record<string,EvidenceTruth>;
}
export const workflowIdSchema=z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const digest=z.string().regex(/^[0-9a-f]{64}$/);
export const procedureScopeSchema=z.strictObject({
  applicationId:workflowIdSchema,pageType:workflowIdSchema,accountScope:digest,language:workflowIdSchema,
  environmentFingerprint:digest,observerVersion:workflowIdSchema,
});
const truth=z.union([z.boolean(),z.literal('unknown')]);
const uniqueIds=(id:typeof workflowIdSchema)=>z.array(id).max(64).refine(ids=>new Set(ids).size===ids.length);
/** The catalog is supplied by trusted application code, never by a teacher or UI observation. */
export function workflowSchemas(catalog:WorkflowCatalog) {
  const action=workflowIdSchema.refine(id=>catalog.actionIds.includes(id));
  const predicate=workflowIdSchema.refine(id=>catalog.predicateIds.includes(id));
  const predicates=uniqueIds(predicate);
  return {
    definition:z.strictObject({schemaVersion:z.literal(1),procedureId:workflowIdSchema,scope:procedureScopeSchema,
      ttlMs:z.number().int().positive().max(7*24*60*60*1000),goalPredicates:predicates.min(1),
      steps:z.array(z.strictObject({actionId:action,preconditions:predicates.min(1),postconditions:predicates.min(1),
        mayInvalidate:predicates,safeRepeat:z.boolean()})).min(1).max(12)}),
    evidence:z.strictObject({trialId:workflowIdSchema,startStateKey:workflowIdSchema,executor:z.enum(['teacher','jev','direct']),
      completedAt:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),independentlyVerified:z.boolean(),
      terminal:truth,actionUnknown:z.boolean(),regression:truth,predicates:z.record(predicate,truth)}),
  };
}
export function parseProcedureDefinition(value:unknown,catalog:WorkflowCatalog):ProcedureDefinition {
  const result=workflowSchemas(catalog).definition.safeParse(value);
  if(!result.success)throw new Error('INVALID_DEFINITION');
  return result.data;
}
export function parseTrialEvidence(value:unknown,catalog:WorkflowCatalog):TrialEvidence {
  const result=workflowSchemas(catalog).evidence.safeParse(value);
  if(!result.success)throw new Error('INVALID_EVIDENCE');
  return result.data;
}
