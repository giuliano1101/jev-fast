import {taskSchema,type Goal} from '../src/core/contracts.js';
export const evaluationSeeds=[1,2,3,4,5];
export const calibrationSeeds=[101,102,103,104,105];
export function taskSuite():Goal[]{return taskSchema.options.flatMap(task=>(['en','zh'] as const).flatMap(language=>evaluationSeeds.map(seed=>({task,language,seed}))));}
