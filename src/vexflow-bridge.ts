import * as VexFlowModule from 'vexflow/bravura';

declare global {
  interface Window {
    VexFlowLib?: typeof VexFlowModule;
  }
}

window.VexFlowLib = VexFlowModule;
window.dispatchEvent(new CustomEvent('vexflow-ready', { detail: VexFlowModule }));
