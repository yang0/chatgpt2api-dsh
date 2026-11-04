/**
 * Minimal Hooks compatibility shim ONLY for the independent offline preview.
 * The installed DSH browser plugin uses the host's real React implementation.
 * Preact code is MIT-licensed; see demo/vendor/LICENSE-preact.txt.
 */
import { createElement, render, options } from './vendor/preact.mjs';
let current = null;
let index = 0;
const previousRender = options.__r;
options.__r = (vnode) => {
  if (typeof previousRender === 'function') previousRender(vnode);
  current = vnode.__c;
  if (current && !current.__apsHooks) current.__apsHooks = [];
  index = 0;
};
const same = (a,b) => !!a && !!b && a.length === b.length && a.every((x,i)=>Object.is(x,b[i]));
function getHook(factory) {
  const owner = current;
  if (!owner) throw new Error('Hook called outside a component');
  const pos = index++;
  if (!owner.__apsHooks[pos]) owner.__apsHooks[pos] = factory();
  return [owner,owner.__apsHooks[pos]];
}
export const React = {
  createElement,
  useState(initial) {
    const [owner, hook] = getHook(() => ({ value: typeof initial === 'function' ? initial() : initial }));
    return [hook.value, next => {
      const value = typeof next === 'function' ? next(hook.value) : next;
      if (Object.is(hook.value, value)) return;
      hook.value = value;
      owner.setState({ __apsTick: (owner.state.__apsTick||0)+1 });
    }];
  },
  useRef(value) { return getHook(() => ({ current:value }))[1]; },
  useMemo(fn,deps) {
    const [,hook] = getHook(() => ({ initialized:false,value:null,deps:null }));
    if (!hook.initialized || !same(hook.deps,deps)) {
      hook.initialized=true; hook.value=fn(); hook.deps=deps;
    }
    return hook.value;
  },
  useEffect(fn,deps) {
    const [,hook] = getHook(() => ({ initialized:false,deps:null,cleanup:null }));
    if (!hook.initialized || !same(hook.deps,deps)) {
      hook.initialized=true;hook.deps=deps;
      setTimeout(() => { if (typeof hook.cleanup === 'function') hook.cleanup();hook.cleanup=fn(); },0);
    }
  }
};
export const ReactDOM = {render: (element,root) => render(element,root)};
