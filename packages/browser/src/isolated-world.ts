export const ISOLATED_WORLD_NAME = 'MultiProfileCaptureWorld';
export const CDP_BINDING_NAME = '__mpStudioCaptureBinding';

export function getCaptureInjectionScript(): string {
  return `
(function() {
  if (window.__mpStudioInjected) return;
  window.__mpStudioInjected = true;

  function dispatchToBinding(type, payload, target) {
    if (typeof window['${CDP_BINDING_NAME}'] === 'function') {
      try {
        window['${CDP_BINDING_NAME}'](JSON.stringify({
          type: type,
          payload: payload,
          target: target,
          timestamp: Date.now()
        }));
      } catch (e) {}
    }
  }

  function getElementDescriptor(el) {
    if (!el || !(el instanceof Element)) return null;
    var candidates = [];
    var testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
    if (testId) candidates.push('[data-testid="' + testId + '"]');
    if (el.id) candidates.push('#' + el.id);
    var role = el.getAttribute('role');
    if (role) candidates.push('role=' + role);
    if (el.tagName) candidates.push(el.tagName.toLowerCase() + (el.className ? '.' + el.className.split(' ').join('.') : ''));

    var rect = el.getBoundingClientRect();
    return {
      candidates: candidates,
      element_kind: el.tagName.toLowerCase(),
      client_x: rect.left + rect.width / 2,
      client_y: rect.top + rect.height / 2,
      viewport_width: window.innerWidth,
      viewport_height: window.innerHeight
    };
  }

  // Pointer & Click listener
  document.addEventListener('click', function(ev) {
    if (!ev.isTrusted && !window.__mpSimulated) return;
    var desc = getElementDescriptor(ev.target);
    dispatchToBinding('dom.click', {
      button: ev.button,
      detail: ev.detail
    }, desc);
  }, true);

  // Input listener for IME and text mutation
  document.addEventListener('input', function(ev) {
    var target = ev.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
      if (target.type === 'password') {
        // Excluded field: never capture passwords
        return;
      }
      var desc = getElementDescriptor(target);
      dispatchToBinding('text.patch', {
        value: target.value,
        selectionStart: target.selectionStart,
        selectionEnd: target.selectionEnd
      }, desc);
    }
  }, true);

  // Scroll listener
  window.addEventListener('scroll', function() {
    dispatchToBinding('scroll.set', {
      scrollX: window.scrollX,
      scrollY: window.scrollY
    }, null);
  }, { passive: true, capture: true });
})();
  `;
}
