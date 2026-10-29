import test from 'node:test';
import assert from 'node:assert/strict';
import {parseProcedureDefinition,parseTrialEvidence} from '../../bench/hybrid/workflow-contracts.js';
import {catalog,definition,evidence} from '../helpers/hybrid-workflow.js';
test('workflow definitions accept only registered semantic actions and predicates',()=>{
  assert.deepEqual(parseProcedureDefinition(definition,catalog),definition);
  for(const bad of [
    {...definition,script:'eval()'}, {...definition,schemaVersion:2}, {...definition,ttlMs:604800001},
    {...definition,steps:[]}, {...definition,goalPredicates:['unknown']},
    {...definition,steps:[{...definition.steps[0],actionId:'document.querySelector'}]},
    {...definition,steps:[{...definition.steps[0],selector:'#button'}]},
    {...definition,steps:[{...definition.steps[0],preconditions:[]}]},
    {...definition,steps:[{...definition.steps[0],postconditions:['unregistered']}]},
    {...definition,steps:[{...definition.steps[0],mayInvalidate:['unregistered']}]},
    {...definition,scope:{...definition.scope,accountScope:'private@example.com'}},
    {...definition,scope:{...definition.scope,environmentFingerprint:'arbitrary text'}},
    {...definition,scope:{...definition.scope,url:'https://example.com/private'}},
  ])assert.throws(()=>parseProcedureDefinition(bad,catalog),/INVALID_DEFINITION/);
});
test('evidence contains only known predicate booleans or unknown, never page text',()=>{
  assert.deepEqual(parseTrialEvidence(evidence(),catalog),evidence());
  assert.equal(parseTrialEvidence({...evidence(),terminal:'unknown'},catalog).terminal,'unknown');
  for(const bad of [
    {...evidence(),screenshot:'raw'}, {...evidence(),predicates:{'public.done':'private page text'}},
    {...evidence(),predicates:{unknown:true}}, {...evidence(),trialId:'contains spaces'},
    {...evidence(),independentlyVerified:'true'}, {...evidence(),completedAt:Infinity},
    {...evidence(),regression:null}, {...evidence(),executor:'page'},
  ])assert.throws(()=>parseTrialEvidence(bad,catalog),/INVALID_EVIDENCE/);
});
