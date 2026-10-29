import {z} from 'zod';

/** Literal public UI meanings only. Actual visibility is verified by the local UI operator. */
export const PUBLIC_CONTROLS=Object.freeze({
 open_english:'Open English Wikipedia',open_chinese:'Open Chinese Wikipedia',open_japanese:'Open Japanese Wikipedia',
 language_english:'Set search language to English',fill_query:'Enter Kyoto in the search field',submit_search:'Submit the search',
 fill_m1:'Set start month to November',fill_d1:'Set start day to 1',fill_y1:'Set start year to 2026',
 fill_m2:'Set end month to November',fill_d2:'Set end day to 15',fill_y2:'Set end year to 2026',
 include_end:'Select Include end date in calculation',calculate_duration:'Calculate the duration',
 add_days:'Open Add or subtract days',workdays:'Open Business days calculator',
 open_works:'Open content management',open_collections:'Open collections',open_audit:'Open publication status filter',
 open_genre:'Open content type filter',open_sort:'Open sort menu',select_all:'Select all publication statuses',
 select_published:'Select Published status',select_reviewing:'Select Under review status',select_rejected:'Select Rejected status',
 select_image_text:'Select image and text content',select_short_video:'Select short video content',select_long_image_text:'Select long image and text content',
 sort_latest:'Sort by latest publication time',sort_views:'Sort by highest views',sort_likes:'Sort by highest likes',
});
export type PublicControlId=keyof typeof PUBLIC_CONTROLS;
export interface PublicTask {goal:string;controls:readonly PublicControlId[]}
const audit=['open_works','open_audit','select_all','select_published','select_reviewing','select_rejected'] as const;
export const PUBLIC_TASKS:Readonly<Record<'W1'|'W2'|'W3'|'D1'|'D2'|'D3',PublicTask>>=Object.freeze({
 W1:{goal:'From the multilingual Wikipedia homepage, open English Wikipedia.',controls:['open_english','open_chinese','open_japanese']},
 W2:{goal:'On the multilingual Wikipedia homepage, set the search language to English, search for Kyoto, and open its article.',controls:['language_english','fill_query','submit_search','open_english','open_chinese','open_japanese']},
 W3:{goal:'On calculator.net, calculate the duration from November 1, 2026 through November 15, 2026, including the end date.',controls:['fill_m1','fill_d1','fill_y1','fill_m2','fill_d2','fill_y2','include_end','calculate_duration']},
 D1:{goal:'In Douyin creator tools, open content management, then open collections.',controls:['open_works','open_collections']},
 D2:{goal:'In Douyin content management, filter publication status to Published.',controls:audit},
 D3:{goal:'In Douyin content management, filter publication status to Published, filter content type to image and text, and sort by highest views.',controls:[...audit,'open_genre','open_sort','select_image_text','select_short_video','select_long_image_text','sort_latest','sort_views','sort_likes']},
});
for(const task of Object.values(PUBLIC_TASKS)){Object.freeze(task.controls);Object.freeze(task);}
const id=z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const inputSchema=z.strictObject({task_id:z.enum(['W1','W2','W3','D1','D2','D3']),variant:z.enum(['baseline','optimized']),trial_id:id,completed:z.array(id).max(64),candidates:z.array(id).min(1).max(64)});
export type PublicDecisionInput=z.infer<typeof inputSchema>;
export function parsePublicInput(value:unknown):PublicDecisionInput{
 const parsed=inputSchema.safeParse(value);
 if(!parsed.success)throw new Error('INVALID_PUBLIC_INPUT');
 const input=parsed.data,allowed:readonly string[]=PUBLIC_TASKS[input.task_id].controls;
 for(const list of [input.completed,input.candidates])if(new Set(list).size!==list.length||list.some(id=>!allowed.includes(id)))throw new Error('INVALID_PUBLIC_INPUT');
 return input;
}
