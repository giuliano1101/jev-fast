import type {HybridAction,HybridCatalog} from '../hybrid/controller.js';

export const MOBILE_CURRENT_PREDICATES=['page_home','page_bluetooth','page_sharing','page_search_empty','page_search_font','page_search_notification','page_font_preview','page_special_permissions','page_notification_list','page_browser_example','settings_returned'] as const;
export const MOBILE_PREDICATES=[...MOBILE_CURRENT_PREDICATES,'visited_font','visited_example','task_sequence_complete'] as const;
export type MobileTaskId='M1'|'M2'|'M3'|'M4'|'M5'|'M6';
export const MOBILE_ACTION_LABELS:Readonly<Record<string,string>>=Object.freeze({
 open_bluetooth:'Open Bluetooth details from Settings home',
 open_sharing:'Open Connection and sharing details from Settings home',
 open_search:'Open Settings search',
 type_font:'Enter the fixed font search query into the empty search field',
 select_font:'Open Font and display from the font search results',
 type_notification:'Enter the fixed notification search query into the empty search field',
 select_notification:'Open the Device and app notifications search result (Special app access parent)',
 open_notification_list:'Open the Device and app notifications list from Special app access',
 open_example:'Open the fixed example.com URL in the browser and verify its native title',
 resume_settings:'Resume Settings and verify either the font search results or Font and display preview',
 restore_font:'Reopen Font and display from the confirmed Settings return search results',
 back_to_font_search:'Go back from Font and display preview to font search results',
 clear_font_search:'Clear the existing font search query',
});
function action(actionId:string,preconditions:string[],postconditions:string[],deterministic=false):HybridAction {
 return {actionId,preconditions,postconditions,mayInvalidate:[...MOBILE_CURRENT_PREDICATES],safeRepeat:false,deterministic};
}
export const MOBILE_CATALOG:HybridCatalog={predicateIds:[...MOBILE_PREDICATES],actions:[
 action('open_bluetooth',['page_home'],['page_bluetooth']),
 action('open_sharing',['page_home'],['page_sharing']),
 action('open_search',['page_home'],['page_search_empty']),
 action('type_font',['page_search_empty'],['page_search_font'],true),
 action('select_font',['page_search_font'],['page_font_preview']),
 action('type_notification',['page_search_empty'],['page_search_notification'],true),
 action('select_notification',['page_search_notification'],['page_special_permissions']),
 action('open_notification_list',['page_special_permissions'],['page_notification_list']),
 action('open_example',['page_font_preview','visited_font'],['page_browser_example','visited_example']),
 action('resume_settings',['page_browser_example','visited_example'],['settings_returned'],true),
 action('restore_font',['page_search_font','settings_returned','visited_example'],['page_font_preview']),
 action('back_to_font_search',['page_font_preview'],['page_search_font'],true),
 action('clear_font_search',['page_search_font','visited_font'],['page_search_empty'],true),
]};
export interface MobileTask {
 id:MobileTaskId;difficulty:'simple'|'medium'|'complex';title:string;goal:string;
 startPage:'home';goalPredicates:string[];actionIds:string[];catalog:HybridCatalog;
}
const fontSteps=['open_search','type_font','select_font'];
const notificationSteps=['open_search','type_notification','select_notification','open_notification_list'];
function task(id:MobileTaskId,difficulty:MobileTask['difficulty'],title:string,goal:string,goalPredicates:string[],actionIds:string[]):MobileTask {
 // These two homepage links are verified safe alternatives, never synthetic candidates.
 const available=new Set([...actionIds,'open_bluetooth','open_sharing']);
 return {id,difficulty,title,goal,startPage:'home',goalPredicates,actionIds,catalog:{predicateIds:[...MOBILE_PREDICATES],actions:MOBILE_CATALOG.actions.filter(value=>available.has(value.actionId)).map(value=>structuredClone(value))}};
}
/** Fixed public research tasks. No action applies settings or changes permissions. */
export const MOBILE_TASKS:readonly MobileTask[]=[
 task('M1','simple','Bluetooth details','Starting at Settings home, open Bluetooth details and stop.',['page_bluetooth'],['open_bluetooth']),
 task('M2','simple','Connection and sharing details','Starting at Settings home, open Connection and sharing details and stop.',['page_sharing'],['open_sharing']),
 task('M3','medium','Font and display preview','Starting at Settings home, search for 字体, open 字体与显示, and stop on the preview without applying any change.',['page_font_preview'],fontSteps),
 task('M4','medium','Device and app notifications list','Starting at Settings home, search for 通知, select 设备和应用通知, then open 设备和应用通知 from its 特殊应用权限 parent and stop on the list.',['page_notification_list'],notificationSteps),
 task('M5','complex','Font preview across an app switch','Starting at Settings home, search for 字体 and open 字体与显示. Open https://www.example.com in the browser, verify Example Domain in the native toolbar, then resume Settings and verify the font preview is restored.',['visited_example','task_sequence_complete','page_font_preview'],[...fontSteps,'open_example','resume_settings','restore_font']),
 task('M6','complex','Font search then notification search','Starting at Settings home, search for 字体 and open 字体与显示. Go back to font search, clear the query, search for 通知, select 设备和应用通知, then open its row in 特殊应用权限 and stop on the notification list.',['visited_font','task_sequence_complete','page_notification_list'],[...fontSteps,'back_to_font_search','clear_font_search','type_notification','select_notification','open_notification_list']),
];
export function getMobileTask(id:string):MobileTask {
 const found=MOBILE_TASKS.find(value=>value.id===id);if(!found)throw Error('INVALID_MOBILE_TASK');return structuredClone(found);
}
