import {generateKeyPairSync} from 'node:crypto';
import {choiceArgsSchema} from '../../src/choice/contracts.js';
import {signChoiceResponse} from '../../src/remote/choice.js';
const keys=generateKeyPairSync('ed25519');
/** Offline test signer, never imported by production executors or hosted-test runners. */
export function offlineWindowsChoice(params:unknown,selected?:string){
 const args=choiceArgsSchema.parse(params);
 return signChoiceResponse(args,{provider:'jev',model:'jev-1.14.0',selected_id:selected??args.actions[0]!.id,confidence:1,usage:null},{privateKey:keys.privateKey,issuer:'offline-test-gateway',audience:'offline-test-executor',identity:{owner_id:'offline',device_id:'offline',agent_id:'offline'},caller_scope:'offline-test-only'});
}
