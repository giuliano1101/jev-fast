/** Attempt every release in order, without hiding the first failure. */
export async function cleanupAll(steps:ReadonlyArray<()=>Promise<unknown>>):Promise<void>{
 let failed=false;let first:unknown;
 for(const release of steps){try{await release();}catch(error){if(!failed){first=error;failed=true;}}}
 if(failed)throw first;
}
