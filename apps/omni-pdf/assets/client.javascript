// The shell loads its entry as a data URL; the larger engine runs from a short blob URL.
(() => {
  const K = window.kaleidoscope;
  // 엔진이 등록하는 동작을 모두 미리 받아 두어야 자료가 오기 전에 눌린 동작이 유실되지 않는다.
  const actions = ['open', 'change_folder', 'go_up', 'select_file', 'activate', 'order_focus', 'order_remove', 'move_up', 'move_down', 'prev_page', 'next_page', 'set_page', 'set_view', 'toggle_view', 'select_result', 'run', 'save'];
  const handlers = new Map();
  const register = K.handle.bind(K);
  let finish;
  const ready = new Promise(resolve => { finish = resolve; });
  const message = 'PDF 도구 실행 자료를 불러오지 못했습니다. 앱을 다시 설치하세요.';
  for (const name of actions) register(name, async context => {
    if (!await ready) throw new Error(message);
    const handler = handlers.get(name);
    if (!handler) throw new Error(message);
    return handler(context);
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
      K.publish({error:message,has_error:true,has_doc_error:true,doc_error:message,no_file:false,loading:false,show_canvas:false,show_epub:false});
      finish(false);
    } finally { if (url) URL.revokeObjectURL(url); }
  })();
})();
