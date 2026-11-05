// The shell loads its entry as a data URL; the larger engine runs from a short blob URL.
(() => {
  const K = window.kaleidoscope;
  const actions = ['load', 'save', 'remove', 'move_up', 'move_down', 'select_preview'];
  const handlers = new Map();
  const register = K.handle.bind(K);
  let finish;
  const ready = new Promise(resolve => { finish = resolve; });
  const message = 'PDF 도구 실행 자료를 불러오지 못했습니다. 앱을 다시 설치하세요.';
  for (const name of actions) register(name, async context => {
    if (!await ready) throw new Error(message);
    return handlers.get(name)(context);
  });
  K.handle = (name, handler) => actions.includes(name) ? handlers.set(name, handler) : register(name, handler);
  void (async () => {
    let url;
    try {
      const bytes = await K.assets.bytes('omni-pdf-engine');
      url = URL.createObjectURL(new Blob([bytes], {type:'text/javascript'}));
      const script = document.createElement('script');
      script.src = url;
      await new Promise((resolve, reject) => {
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
      if (!actions.every(name => handlers.has(name))) throw new Error(message);
      finish(true);
    } catch {
      K.publish({error:message,has_error:true,loading:false,show_result:false,no_result:true});
      finish(false);
    } finally { if (url) URL.revokeObjectURL(url); }
  })();
})();
