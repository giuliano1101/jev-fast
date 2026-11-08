import {DesktopExecutor} from './dist/src/desktop/executor.js';
import {parseDesktopTool} from './dist/src/desktop/contracts.js';
const methods = new Set(['desktop_click', 'desktop_type_text', 'desktop_set_value', 'desktop_press_key', 'desktop_scroll', 'desktop_drag', 'desktop_perform_action', 'desktop_activate_app', 'desktop_launch_app', 'desktop_open_document']);

/** Exact observed matching only. Omit target for a grounded window-level key action. */
export function nativeCandidate(state, {id, description, method, label, role, params = {}}) {
  if (!methods.has(method)) throw Error('UNSUPPORTED_NATIVE_ACTION');
  const input = {...params, app:state.app.bundle_id ?? state.app.pid};
  if (!['desktop_launch_app', 'desktop_open_document', 'desktop_activate_app'].includes(method)) input.observation_id = state.observation_id;
  if (label !== undefined) {
    const matches = state.elements.filter(node => node.enabled && node.label === label && (!role || node.role === role));
    if (matches.length !== 1) throw Error('TARGET_NOT_UNIQUE');
    input.element_id = matches[0].element_id;
  }
  return {id, description, method, input:parseDesktopTool(method, input)};
}
/** AX omits value when the attribute is absent. Keep that absence out of the digest; do not coerce it to null, false, 0, or "". */
function targetBinding(node) {
  const target = {role:node.role, label:node.label, bounds:node.bounds};
  if (node.value !== undefined) target.value = node.value;
  return target;
}
export class NativeAdapter {
  kind = 'native';
  constructor({app, windowId, desktop = new DesktopExecutor()}) {
    if (!app) throw Error('APP_REQUIRED');
    this.app = app; this.windowId = windowId; this.desktop = desktop;
  }
  scope() { return {kind:this.kind, app:this.app}; }
  status() { return this.desktop.call('desktop_status', {}); }
  async prepare(candidate,state) {
    if(['desktop_type_text','desktop_press_key','desktop_scroll','desktop_drag'].includes(candidate.method)) {
      await this.desktop.call('desktop_activate_app',{app:this.app,window_id:state.window.window_id});
    }
  }
  observe() { return this.desktop.call('desktop_get_state', {app:this.app, ...(this.windowId ? {window_id:this.windowId} : {})}); }
  guard(candidate, state) {
    if (!methods.has(candidate.method) || candidate.input.app !== (state.app.bundle_id ?? state.app.pid)) throw Error('INVALID_NATIVE_BINDING');
    const input = parseDesktopTool(candidate.method, candidate.input);
    const node = input.element_id ? state.elements.find(n => n.element_id === input.element_id) : undefined;
    if (input.element_id && (!node || !node.enabled)) throw Error('INVALID_NATIVE_BINDING');
    const {observation_id:_observation, element_id:_element, ...parameters} = input;
    return {method:candidate.method, parameters, pid:state.app.pid, window:state.window,
      target:node ? targetBinding(node) : null};
  }
  execute(candidate) { return this.desktop.call(candidate.method, candidate.input); }
  async screenshot(path) {
    const {writeFile} = await import('node:fs/promises');
    const state = await this.observe();
    const shot = await this.desktop.call('desktop_screenshot', {app:this.app, window_id:state.window.window_id});
    await writeFile(path, Buffer.from(shot.image.data, 'base64'), {mode:0o600});
    const {data:_pixels, ...metadata} = shot.image; return metadata;
  }
  close() { return this.desktop.close(); }
}
