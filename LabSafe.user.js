// ==UserScript==
// @name         高校实验室安全助手：支持挂机刷时长和导出试卷自动答题
// @namespace    local.sdu.labsafe.merged
// @version      3.3.4
// @author       Mr_233333
// @homepageURL  https://github.com/Mr-233333/LabSafe
// @supportURL   https://github.com/Mr-233333/LabSafe/issues
// @description  在高校实验室安全教育平台自动播放和切课、处理空闲提示并显示累计学时。支持将当前页或整套试卷导出为 TXT，导入本地答案后核对题号和题干，再自动填写选择题和判断题。交卷由用户操作。
// @include      *lab-study-front*
// @include      *lab-platform*
// @include      *cg-exam*
// @run-at       document-start
// @grant        none
// @noframes
// @license      MIT
// ==/UserScript==

/*
上游脚本
  shutiao2333 · 自动继续学习 + 实时已学时长 v1.1.0
  https://greasyfork.org/zh-CN/scripts/599557
  yfyckbkb · 山大实验室安全教育 - 课程自动播放 v2.5.2
  https://greasyfork.org/zh-CN/scripts/599898

MIT License

Copyright (c) 2026 shutiao2333
Copyright (c) 2026 yfyckbkb
Copyright (c) 2026 Mr_233333 (整合与修改)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

(() => {
  'use strict';

  const section = location.pathname.match(/(?:^|\/)(lab-study-front|lab-platform(?:-front)?|cg-exam(?:-front)?)(?=\/|$)/i)?.[1];
  if (!section || !/^https?:$/.test(location.protocol)) return;

  // 平台累计学时读取与空闲退出处理。
  const MERGE_CONFIG = {
    blockIdleStudy: true,
    blockIdleExam: true,
    idleDialogFallback: true,
    watchdogSeconds: 60,
  };
  const BRIDGE_ID = 'sdu-lab-merged-bridge';
  const BRIDGE_REQ = 'sdu-lab-merged-request';
  const BRIDGE_RES = 'sdu-lab-merged-response';
  const SOURCES = [
    { name: 'study_records/mine', queries: ['records'] },
    { name: 'user_info', queries: ['user', 'user-total'] },
  ];
  const BRIDGE_ERRORS = new Map([
    ['vue-unavailable', '平台组件尚未就绪'],
    ['api-timeout', '平台请求超时'],
    ['api-error', '平台请求失败'],
  ]);

  // 在网页上下文运行，以访问 Vue 和平台已登录的请求方法。
  function pageAgent(config) {
    if (window.__sduLabMergedAgentV3) return;
    window.__sduLabMergedAgentV3 = true;
    // 用共享标记避免网页与脚本沙箱重复启动。
    try { document.documentElement.setAttribute('data-sdu-lab-merged-agent', 'active'); } catch (_) {}
    const nativeTimeout = window.setTimeout;
    const nativeInterval = window.setInterval;
    const studyMark = /showNOoperated|outtimer|NoOperationTime|\u81ea\u52a8\u9000\u51fa|\u662f\u5426\u7ee7\u7eed/;
    const examMark = /showextra|outTimespace|isTimeOut|\u672a\u8fdb\u884c\u7b54\u9898|\u9000\u51fa\u8003\u8bd5\u9875\u9762/;
    let intercepted = 0;
    const sourceOf = fn => {
      try { return Function.prototype.toString.call(fn); } catch (_) { return ''; }
    };
    const which = fn => {
      if (typeof fn !== 'function') return '';
      const text = sourceOf(fn);
      if (studyMark.test(text)) return 'study';
      if (examMark.test(text)) return 'exam';
      return '';
    };
    const allowed = kind => (kind === 'study' && config.study) || (kind === 'exam' && config.exam);
    if (config.study || config.exam) {
      window.setTimeout = function (fn, delay, ...args) {
        const kind = which(fn);
        if (allowed(kind) && typeof delay === 'number' && delay >= 60000 && delay <= 3600000) {
          intercepted++;
          return 0;
        }
        return nativeTimeout.apply(window, [fn, delay, ...args]);
      };
      window.setInterval = function (fn, delay, ...args) {
        const kind = which(fn);
        if (allowed(kind)) {
          intercepted++;
          return 0;
        }
        return nativeInterval.apply(window, [fn, delay, ...args]);
      };
    }

    let vmCache = null;
    function findVue() {
      try {
        if (vmCache && vmCache.$el && document.contains(vmCache.$el) &&
            vmCache.commonMethods && typeof vmCache.commonMethods.emitAjax === 'function') return vmCache;
      } catch (_) { vmCache = null; }
      for (const selector of ['#chingo', '.positionRight', '.person-wrap', '.container', 'body > *']) {
        for (const element of document.querySelectorAll(selector)) {
          const vm = element.__vue__;
          if (vm && vm.commonMethods && typeof vm.commonMethods.emitAjax === 'function') {
            vmCache = vm;
            return vm;
          }
        }
      }
      for (const element of document.querySelectorAll('*')) {
        const vm = element.__vue__;
        if (vm && vm.commonMethods && typeof vm.commonMethods.emitAjax === 'function') {
          vmCache = vm;
          return vm;
        }
      }
      return null;
    }
    function valueOf(v) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0) return Number(v);
      return null;
    }
    function locateTotal(object, depth = 0, visited = new Set()) {
      if (!object || typeof object !== 'object' || depth > 4 || visited.has(object)) return { found: false };
      visited.add(object);
      if (Object.prototype.hasOwnProperty.call(object, 'totalStudyLength')) {
        const value = valueOf(object.totalStudyLength);
        if (value !== null) return { found: true, value };
        if (object.totalStudyLength === null) return { found: true, nullValue: true };
      }
      // 优先读取响应外层的累计学时字段。
      for (const key of ['data', 'result', 'content', 'studyObj', 'pageStuty']) {
        if (object[key] && typeof object[key] === 'object') {
          const result = locateTotal(object[key], depth + 1, visited);
          if (result.found) return result;
        }
      }
      if (Array.isArray(object)) return { found: false };
      for (const key of Object.keys(object).slice(0, 60)) {
        if (['data', 'result', 'content', 'studyObj', 'pageStuty'].includes(key)) continue;
        const child = object[key];
        if (child && typeof child === 'object') {
          const result = locateTotal(child, depth + 1, visited);
          if (result.found) return result;
        }
      }
      return { found: false };
    }
    function componentValue(vm) {
      const stack = [vm && vm.$root ? vm.$root : vm];
      const seen = new Set();
      let count = 0;
      while (stack.length && count++ < 600) {
        const part = stack.pop();
        if (!part || seen.has(part)) continue;
        seen.add(part);
        for (const obj of [part, part.studyObj, part.pageStuty]) {
          const value = obj && valueOf(obj.totalStudyLength);
          if (value !== null && value !== undefined) return value;
        }
        if (Array.isArray(part.$children)) stack.push(...part.$children);
      }
      return null;
    }
    function studyQuery(key) {
      if (key === 'records') {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 365).getTime();
        const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
        return { path: '/api/study_records/mine', data: { page: 0, size: 10, searchStart: start, searchEnd: end } };
      }
      if (key === 'user') return { path: '/api/user_info', data: {} };
      if (key === 'user-total') return { path: '/api/user_info', data: { isNeedTotalStudyLength: 1 } };
      return null;
    }
    const respond = payload => {
      const bridge = document.getElementById(config.bridgeId);
      if (!bridge) return;
      bridge.setAttribute('data-response', JSON.stringify(payload));
      try { document.dispatchEvent(new Event(config.responseEvent)); }
      finally { bridge.removeAttribute('data-response'); }
    };
    document.addEventListener(config.requestEvent, () => {
      const node = document.getElementById(config.bridgeId);
      if (!node) return;
      const raw = node.getAttribute('data-request');
      node.removeAttribute('data-request');
      let request;
      try { request = JSON.parse(raw); } catch (_) { return; }
      if (!Number.isSafeInteger(request?.id) || request.id < 1) return;
      const query = request.mode === 'read' ? studyQuery(request.query) : null;
      if (!query && request.mode !== 'check') return;
      const result = { id: request.id, ok: false, interceptions: intercepted };
      const vm = findVue();
      result.foundVue = !!vm;
      if (!vm) { result.error = 'vue-unavailable'; respond(result); return; }
      result.localValue = componentValue(vm);
      if (request.mode === 'check') {
        result.ok = true;
        respond(result);
        return;
      }
      let settled = false;
      const timer = nativeTimeout.call(window, () => {
        finish({ error: 'api-timeout' });
      }, 6000);
      function finish(patch) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        Object.assign(result, patch);
        respond(result);
      }
      try {
        vm.commonMethods.emitAjax({
          path: query.path,
          data: query.data,
          errorTipExecuteCallback: true,
          success: response => {
            const total = locateTotal(response);
            const report = { ok: true, fieldFound: total.found, value: total.value ?? null,
              nullValue: !!total.nullValue };
            if (typeof total.value === 'number') {
              try { vm.$store && vm.$store.commit('setTotalStudyLength', total.value); } catch (_) { /* ignored */ }
            }
            finish(report);
          },
          error: () => finish({ error: 'api-error' }),
        });
      } catch (_) { finish({ error: 'api-error' }); }
    });
  }

  let agentInjected = false;
  function injectAgent() {
    // 注入网页脚本，以兼容 Firefox 用户脚本沙箱与网页之间的隔离。
    try {
      const code = '(' + pageAgent.toString() + ')(' + JSON.stringify({
        bridgeId: BRIDGE_ID, requestEvent: BRIDGE_REQ, responseEvent: BRIDGE_RES,
        study: MERGE_CONFIG.blockIdleStudy, exam: MERGE_CONFIG.blockIdleExam,
      }) + ')';
      const tag = document.createElement('script');
      tag.textContent = code;
      (document.head || document.documentElement).appendChild(tag);
      tag.remove();
      agentInjected = true;
    } catch (_) { agentInjected = false; }
    // 仅在注入失败时直接运行，避免两处同时处理桥接事件。
    if (document.documentElement?.getAttribute('data-sdu-lab-merged-agent') !== 'active') {
      try {
        pageAgent({ bridgeId: BRIDGE_ID, requestEvent: BRIDGE_REQ, responseEvent: BRIDGE_RES,
          study: MERGE_CONFIG.blockIdleStudy, exam: MERGE_CONFIG.blockIdleExam });
      } catch (_) { /* no accessible page context */ }
    }
  }
  injectAgent();



  // 比控制面板更早处理播放器，避免平台自带 autoplay 在脚本启动前发声。
  function quietPlayer() {
    for (const video of document.querySelectorAll('#J_prismPlayer video')) {
      video.muted = true;
      video.defaultMuted = true;
    }
  }
  const quietObserver = new MutationObserver(quietPlayer);
  quietObserver.observe(document, { childList: true, subtree: true });
  quietPlayer();

  function boot() {

  const ID = 'sdu-lab-autoplay-panel';
  if (document.getElementById(ID)) return;

  const speeds = [1, 1.25, 1.5, 2, 2.5, 3];
  const savedSpeed = Number(sessionStorage.getItem('sdu-autoplay-speed'));
  // 上一版保存的序号在“已学条目被移除”后会失效，升级时清理这类上下文。
  try {
    const legacy = JSON.parse(sessionStorage.getItem('sdu-autoplay-return') || 'null');
    if (legacy && !Object.prototype.hasOwnProperty.call(legacy, 'nextName')) {
      sessionStorage.removeItem('sdu-autoplay-return');
      sessionStorage.removeItem('sdu-autoplay-return-done');
    }
  } catch (_) {
    sessionStorage.removeItem('sdu-autoplay-return');
    sessionStorage.removeItem('sdu-autoplay-return-done');
  }

  const state = {
    running: sessionStorage.getItem('sdu-autoplay-running') === 'yes',
    next: sessionStorage.getItem('sdu-autoplay-next') !== 'no',
    articles: sessionStorage.getItem('sdu-autoplay-articles') === 'yes',
    speed: speeds.includes(savedSpeed) ? savedSpeed : 1,
    lastNext: 0,
    busy: false,
    media: new WeakMap(),
    articleKey: '',
    articleDoneAt: 0,
    loadAt: 0,
    transition: null,
    modalClicks: new WeakMap(),
    endedModals: new WeakMap(),
    navigationAt: 0,
    returnedAt: 0,
    lastTick: Number(sessionStorage.getItem('sdu-autoplay-last-tick')) || Date.now(),
    lastPersist: 0,
    gap: Number(sessionStorage.getItem('sdu-autoplay-gap')) || 0,
    blocked: null,
    watched: new WeakSet(),
    queue: false,
  };

  const panel = document.createElement('div');
  panel.id = ID;
  panel.style.cssText = 'position:fixed;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));' +
    'z-index:2147483647;width:min(312px,calc(100vw - 24px));max-height:82vh;overflow:auto;' +
    'box-sizing:border-box;background:#fff;color:#202020;border:1px solid #e1e1e1;border-radius:12px;' +
    'padding:13px;box-shadow:0 5px 25px #0003;font:13px/1.5 system-ui,sans-serif;text-align:left';
  const shadow = panel.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host {color-scheme:light}
      * {box-sizing:border-box}
      button {cursor:pointer;border:0;border-radius:6px;padding:6px 10px;background:#1664d9;color:white;font:inherit;white-space:nowrap}
      button:active {opacity:.78}
      button.secondary {background:#f1f3f5;color:#36465a;border:1px solid #d7dce2}
      .head {display:flex;align-items:center;justify-content:space-between;gap:6px;margin:0 0 8px}
      .head strong {font-size:14px}
      .head span {font-size:11px;color:#999}
      .time {padding:9px 12px;background:#f5f8ff;border:1px solid #e1eafd;border-radius:9px;margin:7px 0 9px}
      .time label {font-size:12px;color:#555}
      #realTime {font-size:27px;line-height:1.35;font-weight:750;letter-spacing:1px;font-variant-numeric:tabular-nums;color:#1664d9}
      #realTime.warn {font-size:18px;color:#b55636}
      #realSource {font-size:11px;color:#777;overflow-wrap:anywhere;margin:2px 0 0}
      .row {display:flex;gap:7px;margin:7px 0;align-items:center;flex-wrap:wrap}
      label {cursor:pointer;font-size:12px}
      label:has(input) {display:inline-flex;align-items:center;gap:3px}
      #speed {max-width:70px;font-size:12px;padding:3px 1px}
      #status {font-size:12px;color:#555;overflow-wrap:anywhere;margin-top:7px}
      small {display:block;color:#777;margin-top:6px;font-size:11px}
      #diag {padding-top:6px;border-top:1px solid #eee}
      #diagLog {margin:6px 0 0;background:#f6f7f9;border-radius:5px;max-height:170px;overflow:auto;white-space:pre-wrap;word-break:break-word;padding:7px;font:10px/1.5 ui-monospace,monospace}
      #details[hidden],#diag[hidden] {display:none!important}
      #quizTools[hidden],#quizStop[hidden],#answerStop[hidden],#answerFile[hidden],#answerIssues[hidden] {display:none!important}
      #quizTools {padding:9px 0;border-top:1px solid #e9eef6;margin-top:8px}
      #quizProgress {font-size:11px;color:#777;overflow-wrap:anywhere;margin:3px 0 1px}
      #answerTools {border-top:1px solid #e9eef6;margin-top:9px;padding-top:8px}
      #answerStatus {font-size:11px;color:#555;overflow-wrap:anywhere;white-space:pre-line}
      #answerIssues {font-size:10px;color:#9a582b;white-space:pre-wrap;overflow-wrap:anywhere;max-height:105px;overflow:auto;padding:4px 0}
      #answerTools button {font-size:12px}
      .credit {text-align:center;border-top:1px solid #eef0f3;margin-top:11px;padding-top:9px;
        font-size:11px;line-height:1.65;color:#89909a;letter-spacing:.15px}
      .credit span {display:block}
    </style>
    <div class="head"><strong>高校实验室安全助手</strong><span>v3.3.4</span></div>
    <div class="time">
      <label>平台累计已学（每秒刷新）</label>
      <div id="realTime">读取中\u2026</div>
      <small id="realSource">正在读取服务器学时</small>
    </div>
    <div class="row">
      <button id="toggle" type="button">开始</button>
      <button id="fold" class="secondary" type="button">收起</button>
      <button id="refreshTime" class="secondary" type="button">刷新学时</button>
    </div>
    <div id="quizTools" hidden>
      <div class="row"><button id="quizExportAll" type="button">导出全部题目 TXT</button><button id="quizExportPage" class="secondary" type="button">仅当前页</button><button id="quizStop" class="secondary" type="button" hidden>停止并保存</button></div>
      <div id="quizProgress"></div>
      <div id="answerTools">
        <strong style="display:block;font-size:12px;margin-bottom:4px">答案导入 / 自动填写</strong>
        <div class="row"><button id="answerChoose" type="button">导入答案 TXT / JSON</button><button id="answerTemplate" class="secondary" type="button">本页答案模板</button></div>
        <input id="answerFile" type="file" accept=".txt,.json,.csv,text/plain,application/json" hidden>
        <div class="row"><button id="answerPreview" class="secondary" type="button">检查匹配</button><label><input type="checkbox" id="answerOverwrite">允许覆盖已选</label></div>
        <div class="row"><button id="answerFillPage" type="button">填写当前页</button><button id="answerFillAll" type="button">填写整套题</button><button id="answerStop" type="button" class="secondary" hidden>停止填写</button></div>
        <div id="answerStatus" role="status"></div><div id="answerIssues" hidden></div>
        <small>仅操作题目选项，不点击交卷；导入后先核对题号、题干和匹配数量。</small>
      </div>
    </div>
    <div id="details">
      <div class="row">
        <span>静音播放</span>
        <label>倍速 <select id="speed" aria-label="视频倍速">
          <option value="1">1\u00d7</option><option value="1.25">1.25\u00d7</option>
          <option value="1.5">1.5\u00d7</option><option value="2">2\u00d7</option>
          <option value="2.5">2.5\u00d7</option><option value="3">3\u00d7</option>
        </select></label>
        <label><input id="next" type="checkbox" checked>结束后下一课</label>
        <label><input id="articles" type="checkbox">图文达标自动切课</label>
      </div>
      <div id="status" role="status">请打开课程，再点击开始。</div>
      <small id="health">等待启动</small>
      <small>学时以平台服务器记录为准；倍速不保证学时同比增长。</small>
      <div class="row"><button id="showDiag" class="secondary" type="button">诊断日志</button></div>
      <div id="diag" hidden>
        <div class="row">
          <button id="selfCheck" class="secondary" type="button">自检</button>
          <button id="copyLog" class="secondary" type="button">复制</button>
          <button id="saveLog" class="secondary" type="button">下载</button>
          <button id="clearLog" class="secondary" type="button">清空</button>
        </div>
        <pre id="diagLog"></pre>
      </div>
    </div>
    <div class="credit" aria-label="作者署名">
      <span>Made by Mr_233333</span>
      <span>With ❤️</span>
    </div>`;
  document.body.appendChild(panel);

  const $ = (selector) => shadow.querySelector(selector);
  const status = (message) => { $('#status').textContent = message; };
  $('#toggle').textContent = state.running ? '暂停' : '开始';
  $('#next').checked = state.next;
  $('#articles').checked = state.articles;
  $('#speed').value = String(state.speed);

  // 自动播放暂停、面板收起或站内切页时，继续刷新平台累计学时。
  const timeState = {
    seconds: null, source: '', updatedAt: 0,
    lastPoll: 0, polls: 0, preferred: 0, inFlight: false,
    nextId: 0, pending: null, errors: 0, error: '',
  };
  const LOGS = [];
  function fmtHMS(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    return [Math.floor(value / 3600), Math.floor(value % 3600 / 60), value % 60]
      .map(number => String(number).padStart(2, '0')).join(':');
  }
  function note(message) {
    const clock = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    LOGS.push('[' + clock + '] ' + message);
    if (LOGS.length > 250) LOGS.shift();
    if (!$('#diag').hidden) $('#diagLog').textContent = LOGS.join('\n');
  }
  function paintTime() {
    const value = $('#realTime');
    const detail = $('#realSource');
    if (timeState.seconds !== null) {
      value.textContent = fmtHMS(timeState.seconds);
      value.classList.remove('warn');
      const moment = new Date(timeState.updatedAt).toLocaleTimeString('zh-CN', { hour12: false });
      detail.textContent = timeState.source + ' \u00b7 ' + moment +
        (timeState.error ? ' \u00b7 刷新失败' : '');
    } else if (timeState.error) {
      value.textContent = '暂无数据';
      value.classList.add('warn');
      detail.textContent = timeState.error;
    } else {
      value.textContent = '读取中\u2026';
      detail.textContent = '正在读取服务器学习时长';
    }
  }
  let responseNode = null;
  function getBridgeNode() {
    if (responseNode?.isConnected) return responseNode;
    responseNode = document.getElementById(BRIDGE_ID);
    if (!responseNode) {
      responseNode = document.createElement('div');
      responseNode.id = BRIDGE_ID;
      responseNode.style.display = 'none';
      (document.body || document.documentElement).appendChild(responseNode);
    }
    return responseNode;
  }
  function callBridge(query, mode, callback) {
    if (timeState.pending) { callback(null, 'bridge busy'); return; }
    const id = ++timeState.nextId;
    let complete = false;
    const finish = (result, error) => {
      if (complete) return;
      complete = true;
      clearTimeout(watch);
      if (timeState.pending?.id === id) timeState.pending = null;
      callback(result, error);
    };
    const watch = setTimeout(() => finish(null, 'bridge timeout (8s)'), 8000);
    timeState.pending = { id, finish };
    try {
      const node = getBridgeNode();
      node.setAttribute('data-request', JSON.stringify({ id, query, mode }));
      try { document.dispatchEvent(new Event(BRIDGE_REQ)); }
      finally { node.removeAttribute('data-request'); }
    } catch (_) { finish(null, '桥接请求失败'); }
  }
  document.addEventListener(BRIDGE_RES, () => {
    if (!timeState.pending) return;
    let payload;
    try { payload = JSON.parse(getBridgeNode().getAttribute('data-response') || 'null'); }
    catch (_) { return; }
    if (payload && payload.id === timeState.pending.id) timeState.pending.finish(payload, null);
  });

  function saveTime(seconds, source) {
    timeState.seconds = seconds;
    timeState.source = source;
    timeState.updatedAt = Date.now();
    timeState.errors = 0;
    timeState.error = '';
    paintTime();
  }
  function fetchTime(force = false) {
    if (timeState.inFlight) return;
    // 每秒尝试刷新一次累计学时。上次请求未完成时跳过本次，后台限频也可能延迟刷新。
    const frequency = 1000;
    if (!force && Date.now() - timeState.lastPoll < frequency) return;
    timeState.lastPoll = Date.now();
    timeState.inFlight = true;
    timeState.polls++;
    if (force || timeState.polls % 8 === 0) timeState.preferred = 0;
    const first = timeState.preferred;
    const attempts = [];
    for (let i = first; i < SOURCES.length; i++) {
      for (const query of SOURCES[i].queries) attempts.push({ index: i, source: SOURCES[i], query });
    }
    let localFallback = null;
    const failures = [];
    function attempt(n) {
      if (n >= attempts.length) {
        timeState.inFlight = false;
        timeState.errors++;
        const why = failures.slice(-2).join(' / ') || '服务器未提供时长统计';
        timeState.error = why;
        if (timeState.seconds === null && localFallback !== null) {
          saveTime(localFallback, '页面组件备用值');
        } else paintTime();
        if (timeState.errors <= 2 || timeState.errors % 6 === 0) note('time read failed: ' + why);
        return;
      }
      const item = attempts[n];
      callBridge(item.query, 'read', (reply, error) => {
        if (Number.isFinite(reply?.localValue) && reply.localValue >= 0) localFallback = reply.localValue;
        if (!error && reply && reply.ok && typeof reply.value === 'number' && Number.isFinite(reply.value)) {
          timeState.inFlight = false;
          timeState.preferred = item.index;
          const before = timeState.source;
          saveTime(reply.value, '服务器: ' + item.source.name);
          if (before !== timeState.source) note('time source: ' + item.source.name);
          return;
        }
        failures.push(item.source.name + ': ' +
          (error || BRIDGE_ERRORS.get(reply?.error) || (reply?.nullValue ? 'null totalStudyLength' : 'totalStudyLength missing')));
        attempt(n + 1);
      });
    }
    attempt(0);
  }
  $('#refreshTime').addEventListener('click', () => {
    note('manual time refresh');
    fetchTime(true);
  });
  $('#showDiag').addEventListener('click', () => {
    const diag = $('#diag');
    diag.hidden = !diag.hidden;
    if (!diag.hidden) {
      note('platform section=' + section.toLowerCase());
      note('autoplay=' + state.running + ' / bridgeInjected=' + agentInjected +
        ' / lastSuccess=' + (timeState.updatedAt ? new Date(timeState.updatedAt).toISOString() : '-'));
      $('#diagLog').textContent = LOGS.join('\n');
    }
  });
  $('#selfCheck').addEventListener('click', () => {
    note('running bridge diagnostics');
    callBridge('', 'check', (reply, error) => {
      if (error) note('bridge: ' + error);
      else note('bridge: Vue=' + Boolean(reply.foundVue) + ', idleTimersBlocked=' +
        (Number.isSafeInteger(reply.interceptions) ? reply.interceptions : 0) +
        ', localValueAvailable=' + Number.isFinite(reply.localValue));
      $('#diagLog').textContent = LOGS.join('\n');
      fetchTime(true);
    });
  });
  function textLog() {
    return 'LabSafe 诊断日志\n页面类型: ' + section.toLowerCase() + '\n' +
      'Last time source: ' + timeState.source + '\n' + LOGS.join('\n');
  }
  $('#copyLog').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(textLog()); note('log copied'); }
    catch (_) { note('clipboard access failed'); }
  });
  $('#saveLog').addEventListener('click', () => {
    const link = document.createElement('a');
    const url = URL.createObjectURL(new Blob([textLog()], { type: 'text/plain;charset=utf-8' }));
    link.href = url;
    link.download = 'labsafe-merged-log.txt';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  });
  $('#clearLog').addEventListener('click', () => { LOGS.length = 0; $('#diagLog').textContent = ''; });

  // 题目导出读取已登录页面上渲染的题干和选项。
  const QUIZ_TYPES = '(?:单选题|多选题|判断题|填空题|不定项选择题|选择题|简答题|问答题|论述题)';
  const quizTypeExact = new RegExp('^' + QUIZ_TYPES + '$');
  const quizTypeGlobal = new RegExp(QUIZ_TYPES, 'g');
  const quizHeader = new RegExp('(?:^|\\n)\\s*(\\d{1,4})\\s*[.\\uff0e\\u3001]\\s*' + QUIZ_TYPES, 'g');
  const quizBlockTags = new Set(['DIV', 'P', 'ARTICLE', 'SECTION', 'UL', 'OL', 'LI', 'LABEL', 'H1', 'H2', 'H3', 'H4', 'H5', 'TR', 'TD', 'TABLE', 'HEADER']);
  const quizIgnoredTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'BUTTON']);
  const quizJob = { active: false, stop: false, answerBusy: false };
  let quizVisibleCache = false;
  let quizVisibleAt = 0;

  function quizText(root) {
    const parts = [];
    const add = str => { if (str) parts.push(str); };
    function walk(node) {
      if (node.nodeType === 3) { add((node.nodeValue || '').replace(/[\t\r\n\u00a0]+/g, ' ')); return; }
      if (node.nodeType !== 1) return;
      const el = node;
      if (el.id === ID || quizIgnoredTags.has(el.tagName)) return;
      if (el.getAttribute('aria-hidden') === 'true' || el.hidden || el.style?.display === 'none') return;
      const computed = window.getComputedStyle(el);
      if (computed.display === 'none' || computed.visibility === 'hidden') return;
      if (el.tagName === 'IMG') {
        add(' [图片] ');
        return;
      }
      if (el.tagName === 'BR') { add('\n'); return; }
      if (el.tagName === 'INPUT') return;
      const block = quizBlockTags.has(el.tagName);
      if (block) add('\n');
      for (const child of el.childNodes) walk(child);
      if (block) add('\n');
    }
    walk(root);
    return parts.join('')
      .replace(/[\t ]+/g, ' ')
      .replace(/[\t ]*\n[\t ]*/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .replace(/(^|\n)([A-H])[.\uff0e\u3001]\s*\n/g, '$1$2. ')
      .replace(/(^|\n)(\d{1,4})[.\uff0e\u3001]\s*\n/g, '$1$2. ')
      .trim();
  }

  function quizQuestionRoots() {
    const result = [];
    const anchors = document.querySelectorAll('span,em,b,strong,small,i,div');
    for (const anchor of anchors) {
      if (anchor.closest('#' + ID) || anchor.closest('.ivu-modal')) continue;
      if (anchor.childElementCount > 1) continue;
      const name = (anchor.textContent || '').replace(/\s+/g, '');
      if (!quizTypeExact.test(name)) continue;
      let best = null;
      let backup = null;
      for (let parent = anchor.parentElement, depth = 0;
        parent && parent !== document.body && depth < 9;
        parent = parent.parentElement, depth++) {
        if (!visible(parent)) break;
        const raw = parent.textContent || '';
        if (raw.length > 7000 || (raw.match(quizTypeGlobal) || []).length > 1) break;
        const fields = parent.querySelectorAll('input[type="radio"],input[type="checkbox"]').length;
        if (fields >= 2) {
          backup = parent;
          if (/\d{1,4}\s*[.\uff0e\u3001]/.test(raw.slice(0, 200))) { best = parent; break; }
        }
      }
      const node = best || backup;
      if (node && !result.some(item => item === node || item.contains(node) || node.contains(item))) result.push(node);
    }
    return result;
  }

  function parseQuestionsFromText(raw) {
    const found = [...raw.matchAll(new RegExp(quizHeader.source, 'g'))];
    const results = [];
    for (let i = 0; i < found.length; i++) {
      let text = raw.slice(found[i].index, i + 1 < found.length ? found[i + 1].index : raw.length).trim();
      text = text.split(/\n(?:\u4e0a\u4e00\u9875|\u4e0b\u4e00\u9875|\u63d0\u4ea4\u8bd5\u5377|\u63d0\u4ea4\u7b54\u5377|\u4ea4\u5377|\u8fd4\u56de\u9898\u76ee\u5217\u8868|\u7b54\u9898\u5361|\u5f53\u524d\u8fdb\u5ea6|\u5269\u4f59\u65f6\u95f4)\s*(?:\n|$)/)[0].trim();
      if (text.length > 4500) text = text.slice(0, 4500) + '\n[question text shortened]';
      if (text.length > 8) results.push(text);
    }
    return results;
  }

  function readQuizQuestions() {
    const roots = quizQuestionRoots();
    const perRoot = roots.map(quizText).filter(Boolean);
    const combined = perRoot.flatMap(text => parseQuestionsFromText(text));
    if (combined.length) return combined;
    // 自定义单选控件使用文本提取作为回退。
    const overall = quizText(document.body);
    return parseQuestionsFromText(overall);
  }

  function isQuizPage() {
    const now = Date.now();
    if (now - quizVisibleAt < 1600) return quizVisibleCache;
    quizVisibleAt = now;
    if (!document.body) {
      quizVisibleCache = false;
      return false;
    }
    quizVisibleCache = readQuizQuestions().length > 0;
    return quizVisibleCache;
  }

  function quizStatus(message) {
    $('#quizProgress').textContent = message;
  }
  function updateQuizTools() {
    const active = isQuizPage();
    $('#quizTools').hidden = !active && !quizJob.active && !quizJob.answerBusy;
    if (active && !quizJob.active && !$('#quizProgress').textContent) {
      quizStatus('可导出当前页面显示的题干和选项，图片用占位符表示。');
    }
  }

  function quizPager(action) {
    const label = action === 'prev' ? /^(?:\u4e0a\u4e00\u9875|\u4e0a\u9875|\u524d\u4e00\u9875)(?:[\s<\u2039\u00ab\u2190]*)$/ : /^(?:\u4e0b\u4e00\u9875|\u4e0b\u9875|\u540e\u4e00\u9875)(?:[\s>\u203a\u00bb\u2192]*)$/;
    const all = document.querySelectorAll('button,a,[role="button"],.ivu-page-prev,.ivu-page-next,.el-pagination__prev,.el-pagination__next,div,span');
    for (const el of all) {
      if (el.closest('#' + ID) || !visible(el)) continue;
      const txt = (el.textContent || '').replace(/\s+/g, '');
      if (!label.test(txt)) continue;
      if (el.tagName === 'DIV' && el.childElementCount > 3) continue;
      const btn = el.closest('button,a,[role="button"],.ivu-page-prev,.ivu-page-next,.el-pagination__prev,.el-pagination__next,[class*="nextPage"],[class*="prevPage"],[class*="next-page"],[class*="prev-page"]') || el;
      if (!visible(btn) || btn.disabled || btn.getAttribute('aria-disabled') === 'true' || btn.classList.contains('disabled') || btn.classList.contains('ivu-page-disabled') || btn.classList.contains('is-disabled')) continue;
      const css = getComputedStyle(btn);
      if (css.pointerEvents === 'none') continue;
      if (btn.tagName === 'A' && btn.hasAttribute('href')) {
        try {
          const target = new URL(btn.href, location.href);
          if (target.origin !== location.origin || target.pathname !== location.pathname) continue;
        }
        catch (_) { continue; }
      }
      return btn;
    }
    return null;
  }

  const waitQuiz = ms => new Promise(resolve => setTimeout(resolve, ms));
  const quizSignature = list => list.map(text => text.slice(0, 160)).join('||');
  async function waitQuizTurn(previous, initialPath) {
    const deadline = Date.now() + 6200;
    while (Date.now() < deadline) {
      if (quizJob.stop) return null;
      if (location.pathname !== initialPath) return null;
      await waitQuiz(180);
      const fresh = readQuizQuestions();
      if (fresh.length && quizSignature(fresh) !== previous) return fresh;
    }
    return null;
  }

  function downloadQuiz(pages, warnings) {
    const now = new Date();
    const pad = value => String(value).padStart(2, '0');
    const stamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + '_' + pad(now.getHours()) + pad(now.getMinutes());
    const count = pages.reduce((sum, page) => sum + page.questions.length, 0);
    const header = [
      '实验室安全教育平台 - 题目导出',
      '导出时间: ' + now.toLocaleString('zh-CN'),
      '采集页数: ' + pages.length + ' | 题目数: ' + count,
      '说明: 导出页面显示的题干和选项，图片用占位符表示。',
      ...warnings.map(w => '提示: ' + w),
      '',
    ];
    for (const page of pages) {
      header.push('========== ' + '第 ' + page.page + ' 页' + ' ==========');
      for (const q of page.questions) header.push(q, '');
    }
    const payload = '\ufeff' + header.join('\r\n');
    const file = new Blob([payload], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'LabSafe_Questions_' + stamp + '.txt';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    note('quiz exported: ' + count + ' questions / ' + pages.length + ' pages; warnings=' + warnings.length);
    return count;
  }

  function quizButtonsWorking(working) {
    $('#quizExportAll').disabled = working;
    $('#quizExportPage').disabled = working;
    $('#quizStop').hidden = !working;
  }

  function exportVisibleQuiz() {
    const questions = readQuizQuestions();
    if (!questions.length) { quizStatus('未识别到可导出的题目，请打开有题目的练习页。'); return; }
    downloadQuiz([{ page: 1, questions }], ['本文件仅包含当前页面可见题目。']);
    quizStatus('已导出当前页: ' + questions.length + ' 题');
  }

  async function exportAllQuiz() {
    if (quizJob.active) return;
    let questions = readQuizQuestions();
    if (!questions.length) { quizStatus('没有找到可导出的题目'); return; }
    quizJob.active = true;
    quizJob.stop = false;
    quizButtonsWorking(true);
    const initialPath = location.pathname;
    const warnings = [];
    const pages = [];
    const limit = 120;
    let rewound = 0;
    try {
      // 通过平台的上一页按钮回到首页。
      while (!quizJob.stop && rewound < limit) {
        const prev = quizPager('prev');
        if (!prev) break;
        const before = quizSignature(questions);
        quizStatus('正在定位第一页...');
        prev.click();
        const changed = await waitQuizTurn(before, initialPath);
        if (!changed) { warnings.push('无法确认已返回第一页，可能漏掉前面的题目。'); break; }
        questions = changed;
        rewound++;
      }
      if (rewound >= limit) warnings.push('回退超出页数限制。');
      let pageIndex = 0;
      while (!quizJob.stop && pageIndex < limit) {
        questions = readQuizQuestions();
        if (!questions.length) { warnings.push('页面题目读取失败。'); break; }
        pageIndex++;
        pages.push({ page: pageIndex, questions });
        const count = pages.reduce((total, item) => total + item.questions.length, 0);
        quizStatus('正在导出: ' + pageIndex + ' 页 / ' + count + ' 题');
        const next = quizPager('next');
        if (!next) break;
        const before = quizSignature(questions);
        next.click();
        const changed = await waitQuizTurn(before, initialPath);
        if (!changed) { warnings.push('\u201c下一页\u201d点击后未检测到题目变化，导出可能不完整。'); break; }
      }
      if (pageIndex >= limit) warnings.push('达到 ' + limit + ' 页安全限制，导出可能不完整。');
      if (quizJob.stop) warnings.push('用户中止导出，仅保留已采集的题目。');
    } catch (error) {
      warnings.push('导出过程出错: ' + String(error).slice(0, 150));
    } finally {
      quizJob.active = false;
      quizButtonsWorking(false);
    }
    if (pages.length) {
      const count = downloadQuiz(pages, warnings);
      quizStatus('已保存: ' + pages.length + ' 页 / ' + count + ' 题' + (warnings.length ? ' (' + warnings.length + ' 条提示)' : ''));
    } else quizStatus('未能采集题目，请尝试\u201c仅当前页\u201d');
  }

  $('#quizExportPage').addEventListener('click', exportVisibleQuiz);
  $('#quizExportAll').addEventListener('click', exportAllQuiz);
  $('#quizStop').addEventListener('click', () => { quizJob.stop = true; quizStatus('正在停止，将保存已采集题目...'); });
  // 答案导入和填写只操作可见的题目选项，交卷由用户完成。
  // TXT 可用 1=错 或 61=A，在 | 后附原题干可启用题干校验。
  // JSON 支持题号与答案的映射，也可放在 answers 字段下。
  const answerState = {
    entries: new Map(), errors: [], duplicates: [],
    active: false, stop: false, visited: new Set(),
  };
  const ANSWER_CHOICE = /^(?:[A-H])(?:[\s.．、:：)）]|$)/i;
  const ANSWER_CONTROL = 'input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"]';
  const ANSWER_WRAP = 'label,.ivu-radio-wrapper,.ivu-checkbox-wrapper,.el-radio,.el-checkbox,.ant-radio-wrapper,.ant-checkbox-wrapper,[role="radio"],[role="checkbox"]';
  const ANSWER_MARKS = '(?:单选题|多选题|判断题|不定项选择题|选择题|填空题|简答题|问答题|论述题)';
  const answerHeading = new RegExp('(?:^|\\n)\\s*(\\d{1,4})\\s*[.．、]\\s*(' + ANSWER_MARKS + ')');

  const answerNorm = value => String(value || '').normalize('NFKC')
    .replace(/[\s\u200b\u200c\u200d.,!?。，！？“”‘’：:（）()、【】\[\]《》<>"'`·;；\-_]/g, '').toLowerCase();

  function normalizeAnswer(raw) {
    const original = String(raw ?? '').trim().replace(/^[`"']|[`"']$/g, '').trim();
    if (!original || /^(?:\?|？|不确定|未知|待定|跳过|N\/?A|-+)$/i.test(original)) {
      return { kind: 'skip', value: '?', raw: original };
    }
    if (/^(?:对|正确|是|√|✓|T|TRUE|1)$/i.test(original)) return { kind: 'judgment', value: '对', raw: original };
    if (/^(?:错|错误|否|×|✗|✕|FALSE|0)$/i.test(original)) return { kind: 'judgment', value: '错', raw: original };
    const choices = original.toUpperCase().replace(/[\s,，、+＋;；\/]+/g, '');
    if (/^[A-H]{1,8}$/.test(choices) && new Set(choices).size === choices.length) {
      return { kind: 'letters', value: [...choices].sort().join(''), raw: original };
    }
    return null;
  }

  function parseAnswers(source) {
    const entries = new Map(), errors = [], duplicates = [];
    function add(number, rawValue, rawStem, lineNumber) {
      const id = Number(number);
      if (!Number.isInteger(id) || id < 1 || id > 9999) {
        errors.push('第 ' + lineNumber + ' 行：题号不合法'); return;
      }
      if (entries.has(id)) { duplicates.push(id); return; }
      const answer = normalizeAnswer(rawValue);
      if (!answer) { errors.push('第 ' + lineNumber + ' 行：' + id + ' 题的答案无效（' + String(rawValue).slice(0, 25) + '）'); return; }
      entries.set(id, { id, ...answer, stem: String(rawStem || '').trim() });
    }
    const raw = String(source || '').replace(/^\uFEFF/, '').trim();
    if (!raw) { errors.push('答案文件为空'); return { entries, errors, duplicates }; }
    if (/^[{\[]/.test(raw)) {
      try {
        let data = JSON.parse(raw);
        if (data && !Array.isArray(data) && data.answers && typeof data.answers === 'object') data = data.answers;
        if (Array.isArray(data)) {
          data.forEach((item, i) => {
            if (!item || typeof item !== 'object') { errors.push('JSON 第 ' + (i+1) + ' 项不是对象'); return; }
            add(item.number ?? item.no ?? item.id, item.answer, item.stem ?? item.question ?? '', i + 1);
          });
        } else if (data && typeof data === 'object') {
          Object.entries(data).forEach(([id, item], i) => {
            if (item && typeof item === 'object') add(id, item.answer, item.stem ?? item.question ?? '', i + 1);
            else add(id, item, '', i + 1);
          });
        } else errors.push('JSON 顶层应是题号对象或答案数组');
        return { entries, errors, duplicates };
      } catch (error) {
        errors.push('JSON 解析失败：' + String(error.message || error).slice(0, 80));
        return { entries, errors, duplicates };
      }
    }
    raw.replace(/\r/g, '').split('\n').forEach((line, i) => {
      line = line.trim();
      if (!line || /^\s*(?:#|\/\/|```)/.test(line)) return;
      line = line.replace(/^\s*[-*]\s+(?=\d|第\s*\d)/, '');
      const match = line.match(/^(?:第\s*)?(\d{1,4})\s*(?:题)?\s*(?:=|:|：|\.\s*|．|、|\)|）|\])\s*(.+)$/);
      if (!match) { errors.push('第 ' + (i + 1) + ' 行格式不正确：' + line.slice(0, 40)); return; }
      const [val, ...stem] = match[2].split(/[|｜]/);
      add(match[1], val.trim(), stem.join('|').trim(), i + 1);
    });
    return { entries, errors, duplicates };
  }

  function answerStem(block, type) {
    // 略过标题，并在首个选项前结束题干提取。
    const lines = block.split('\n').map(s => s.trim()).filter(Boolean);
    let index = lines.findIndex(s => new RegExp('^\\d{1,4}\\s*[.．、]\\s*' + ANSWER_MARKS).test(s));
    if (index < 0) index = -1;
    const pieces = [];
    if (index >= 0) {
      const remainder = lines[index].replace(new RegExp('^\\d{1,4}\\s*[.．、]\\s*' + ANSWER_MARKS + '(?:\\s*[（(]\\d+\\s*分[）)])?'), '').trim();
      if (remainder) pieces.push(remainder);
    }
    for (let n = index + 1; n < lines.length; n++) {
      const line = lines[n];
      if (ANSWER_CHOICE.test(line) || (type === '判断题' && /^(?:对|错|正确|错误)$/.test(line)) ||
          /^(?:答题卡|当前进度|上一页|下一页|提交试卷|交卷)$/.test(line)) break;
      pieces.push(line);
    }
    return pieces.join(' ').trim();
  }

  function readAnswerQuestions() {
    const result = [], seen = new Set();
    const roots = quizQuestionRoots();
    // 题型标签拆成多个文本节点时，从选项控件向上查找每题的容器。
    const scanHeading = new RegExp('\\d{1,4}\\s*[.．、]\\s*' + ANSWER_MARKS, 'g');
    const inputSelector = 'input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"]';
    const extra = new Set();
    for (const control of document.querySelectorAll(inputSelector)) {
      if (control.closest('#' + ID + ',.ivu-modal,[role="dialog"]') || roots.some(r => r.contains(control))) continue;
      for (let parent = control.parentElement, depth = 0;
        parent && parent !== document.body && depth < 12;
        parent = parent.parentElement, depth++) {
        if (!visible(parent)) break;
        const txt = parent.textContent || '';
        if (txt.length > 9000) break;
        const headers = [...txt.matchAll(new RegExp(scanHeading.source, 'g'))];
        if (headers.length > 1) break;
        if (headers.length !== 1 || parent.querySelectorAll(inputSelector).length < 2) continue;
        extra.add(parent);
        break;
      }
    }
    for (const root of [...roots, ...extra]) {
      const block = quizText(root);
      const match = block.match(answerHeading);
      if (!match || !Number(match[1]) || seen.has(Number(match[1]))) continue;
      if (!root.querySelector(ANSWER_CONTROL)) continue;
      const id = Number(match[1]), type = match[2];
      seen.add(id);
      result.push({ id, type, root, stem: answerStem(block, type) });
    }
    return result.sort((a, b) => a.id - b.id);
  }

  function answerLabelFor(control, questionRoot) {
    let wrapper = control.closest(ANSWER_WRAP);
    if (!wrapper || !questionRoot.contains(wrapper)) wrapper = control;
    let text = quizText(wrapper).replace(/\s+/g, ' ').trim();
    // 兼容选项文字与 <input> 相邻的结构。
    if (!text || (text.length < 2 && /^[.、]$/.test(text))) {
      let current = wrapper;
      for (let n = 0; n < 4 && current?.parentElement && current.parentElement !== questionRoot; n++) {
        current = current.parentElement;
        const count = current.querySelectorAll('input[type="radio"],input[type="checkbox"]').length;
        if (count > 1) break;
        const candidate = quizText(current).replace(/\s+/g, ' ').trim();
        if (candidate.length > text.length && candidate.length < 500) text = candidate;
      }
    }
    return { wrapper, text };
  }

  function answerCandidates(question) {
    let elements = [...question.root.querySelectorAll('input[type="radio"],input[type="checkbox"]')];
    // 兼容仅用 ARIA 表达的选项，并跳过已有原生输入控件的容器。
    if (!elements.length) elements = [...question.root.querySelectorAll('[role="radio"],[role="checkbox"]')];
    const candidates = [];
    for (const control of elements) {
      if (control.disabled || control.getAttribute('aria-disabled') === 'true') continue;
      const { wrapper, text } = answerLabelFor(control, question.root);
      let option = null;
      if (question.type === '判断题') {
        if (/^(?:对|正确|是)(?:\s|$)/.test(text)) option = '对';
        if (/^(?:错|错误|否)(?:\s|$)/.test(text)) option = '错';
      } else {
        const m = text.match(/^\s*([A-H])(?:[\s.．、:：)）]|$)/i);
        if (m) option = m[1].toUpperCase();
      }
      candidates.push({ control, wrapper, option, text });
    }
    // 仅选择文字能够明确匹配的选项，避免判断题选项顺序变化导致错填。
    return candidates;
  }

  function isSelected(candidate) {
    const el = candidate.control;
    if (el instanceof HTMLInputElement) return !!el.checked;
    if (el.getAttribute('aria-checked') === 'true') return true;
    const wrap = candidate.wrapper;
    return !!(wrap?.classList.contains('ivu-radio-wrapper-checked') ||
      wrap?.classList.contains('ivu-checkbox-wrapper-checked') ||
      wrap?.classList.contains('el-radio-checked') ||
      wrap?.classList.contains('el-checkbox-checked') ||
      wrap?.querySelector('.ivu-radio-checked,.ivu-checkbox-checked,.el-radio__input.is-checked,.el-checkbox__input.is-checked'));
  }

  function answerTarget(candidate) {
    const wrap = candidate.wrapper;
    if (wrap && wrap !== candidate.control && visible(wrap)) return wrap;
    return candidate.control;
  }

  function assessAnswer(question, entry) {
    if (!entry || entry.kind === 'skip') return { ok: false, why: '答案未提供/不确定' };
    if (entry.stem) {
      const expected = answerNorm(entry.stem), actual = answerNorm(question.stem);
      if (expected.length < 8 || !actual || !(actual.includes(expected) || expected.includes(actual) && actual.length >= 12)) {
        return { ok: false, why: '题干与答案文件不一致（可能重新抽题）' };
      }
    }
    if (question.type === '判断题' ? entry.kind !== 'judgment' :
        question.type === '单选题' ? (entry.kind !== 'letters' || entry.value.length !== 1) :
        (question.type === '多选题' || question.type === '不定项选择题') ? entry.kind !== 'letters' : true) {
      return { ok: false, why: '题型与答案不匹配或该题型不支持自动填写' };
    }
    const options = answerCandidates(question);
    if (options.length < 2 || options.some(opt => !opt.option)) return { ok: false, why: '选项控件无法可靠识别' };
    const names = options.map(opt => opt.option);
    if (new Set(names).size !== names.length) return { ok: false, why: '检测到重复选项控件' };
    if ([...entry.value].some(letter => !names.includes(letter))) return { ok: false, why: '答案选项在当前题中不存在' };
    return { ok: true, options, targets: new Set([...entry.value]) };
  }

  function answerTextStatus(text, issues = []) {
    $('#answerStatus').textContent = text;
    $('#answerIssues').textContent = issues.length ? issues.slice(0, 12).join('\n') : '';
    $('#answerIssues').hidden = !issues.length;
  }

  function previewAnswers() {
    if (!answerState.entries.size) { answerTextStatus('请先导入答案文件'); return; }
    const questions = readAnswerQuestions();
    let matched = 0, already = 0, noAnswer = 0;
    const absentIDs = [];
    const issues = [];
    const visibleIDs = new Set(questions.map(q => q.id));
    for (const q of questions) {
      const entry = answerState.entries.get(q.id);
      if (!entry || entry.kind === 'skip') { noAnswer++; absentIDs.push(q.id); continue; }
      const plan = assessAnswer(q, entry);
      if (!plan.ok) issues.push(q.id + ' 题：' + plan.why);
      else {
        matched++;
        if ([...plan.options.filter(isSelected).map(opt => opt.option)].sort().join('') === [...plan.targets].sort().join('')) already++;
      }
    }
    const extra = [...answerState.entries.keys()].filter(id => !visibleIDs.has(id)).length;
    const counts = '导入 ' + answerState.entries.size + ' 题，当前页面识别 ' + questions.length +
      ' 题；可匹配 ' + matched + '，已与导入答案一致 ' + already + '，待答/无答案 ' + noAnswer +
      '，不匹配 ' + issues.length + '；其他页答案 ' + extra + '。';
    const messages = [...(absentIDs.length ? ['缺少答案/标记为不确定的题号：' + absentIDs.slice(0, 30).join('、') + (absentIDs.length > 30 ? ' 等' : '')] : []), ...answerState.errors.slice(0, 5), ...answerState.duplicates.slice(0, 5).map(id => '文件中题号 ' + id + ' 重复，后面的答案未采用'), ...issues];
    if (questions.length === 0) messages.unshift('未识别到题目控件。请进入具体答题页面，不支持自动提交。');
    if (answerState.entries.size && ![...answerState.entries.values()].some(v => v.stem)) {
      messages.push('纯题号答案无法校验题干；请确认题目顺序与导出时相同。');
    }
    answerTextStatus(counts, messages);
    return { questions, matched, issues };
  }

  function setAnswerButtons(working) {
    $('#answerChoose').disabled = working;
    $('#answerFillPage').disabled = working;
    $('#answerFillAll').disabled = working;
    $('#quizExportPage').disabled = working;
    $('#quizExportAll').disabled = working;
    $('#answerStop').hidden = !working;
  }

  const answerPause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  async function fillQuestion(q, summary) {
    const entry = answerState.entries.get(q.id);
    if (!entry || entry.kind === 'skip') { summary.missing.add(q.id); return; }
    const plan = assessAnswer(q, entry);
    if (!plan.ok) { summary.issues.push(q.id + ' 题：' + plan.why); return; }
    const selected = plan.options.filter(isSelected);
    const alreadyCorrect = selected.length === plan.targets.size && selected.every(opt => plan.targets.has(opt.option));
    if (alreadyCorrect) { summary.already.add(q.id); return; }
    if (selected.length && !$('#answerOverwrite').checked) {
      summary.issues.push(q.id + ' 题：已有选择，未覆盖（可勾选“允许覆盖”）');
      return;
    }
    const clicks = [];
    if ($('#answerOverwrite').checked) {
      for (const opt of selected) if (!plan.targets.has(opt.option)) clicks.push(opt);
    }
    for (const opt of plan.options) if (plan.targets.has(opt.option) && !isSelected(opt)) clicks.push(opt);
    try {
      for (const opt of clicks) {
        if (answerState.stop || !q.root.isConnected) break;
        answerTarget(opt).click();
        await answerPause(32);
      }
      // 页面可能在点击后重新渲染。重新读取当前题目再确认结果。
      const current = q.root.isConnected ? q : readAnswerQuestions().find(item => item.id === q.id);
      if (!current) { summary.issues.push(q.id + ' 题：点击后题目 DOM 被重建，无法验证'); return; }
      const currentPlan = assessAnswer(current, entry);
      if (!currentPlan.ok) { summary.issues.push(q.id + ' 题：点击后选项无法再定位'); return; }
      const now = currentPlan.options.filter(isSelected).map(opt => opt.option).sort().join('');
      if (now === [...currentPlan.targets].sort().join('')) summary.filled.add(q.id);
      else summary.issues.push(q.id + ' 题：已尝试点击，但页面未确认已选中，请手动检查');
    } catch (e) {
      summary.issues.push(q.id + ' 题：控件点击异常 ' + String(e).slice(0, 50));
    }
  }

  function newAnswerSummary() { return { filled: new Set(), already: new Set(), missing: new Set(), issues: [], pages: 0 }; }
  function showAnswerSummary(summary, suffix = '') {
    const issues = [...summary.issues];
    if (answerState.errors.length) issues.unshift(...answerState.errors.slice(0, 5));
    if (answerState.duplicates.length) issues.unshift('答案文件有 ' + answerState.duplicates.length + ' 个重复题号');
    answerTextStatus('已操作 ' + summary.pages + ' 页：新填 ' + summary.filled.size + ' 题，' +
      '原已按文件选择 ' + summary.already.size + ' 题，无答案/不确定 ' + summary.missing.size + ' 题，' +
      '需人工核对 ' + summary.issues.length + ' 题。' + suffix, issues);
  }

  async function fillAnswerPage(summary) {
    // 每题填写前重新定位控件，以兼容 Vue 重新渲染。
    const currentQuestions = readAnswerQuestions();
    const ids = currentQuestions.map(q => q.id);
    summary.pages++;
    for (const original of currentQuestions) {
      if (answerState.stop) break;
      const id = original.id;
      const question = original.root.isConnected ? original : readAnswerQuestions().find(q => q.id === id);
      if (!question) { summary.issues.push(id + ' 题：已从 DOM 中消失'); continue; }
      await fillQuestion(question, summary);
    }
    return ids;
  }

  async function runAnswerFill(allPages) {
    if (answerState.active || quizJob.active) { answerTextStatus('正在执行另一项操作，请等待完成'); return; }
    if (!answerState.entries.size) { answerTextStatus('请先导入答案 TXT/JSON 文件'); return; }
    const first = readAnswerQuestions();
    if (!first.length) { answerTextStatus('无法识别当前页面的答题控件，未执行任何操作'); return; }
    answerState.active = true;
    quizJob.answerBusy = true;
    answerState.stop = false;
    setAnswerButtons(true);
    const summary = newAnswerSummary(), path = location.pathname;
    try {
      if (allPages) {
        // 填写整套题前先回到题目首页。
        for (let rewind = 0; rewind < 200 && !answerState.stop; rewind++) {
          const previous = quizPager('prev');
          if (!previous) break;
          const before = quizSignature(readQuizQuestions());
          previous.click();
          const changed = await waitQuizTurn(before, path);
          if (!changed) { summary.issues.push('无法确认已经返回上一页，自动停止翻页'); answerState.stop = true; break; }
        }
      }
      const seenSignatures = new Set();
      for (let page = 0; page < (allPages ? 200 : 1) && !answerState.stop; page++) {
        if (location.pathname !== path) { summary.issues.push('页面地址已变化，已停止自动填写'); break; }
        const signature = quizSignature(readQuizQuestions());
        if (seenSignatures.has(signature)) { summary.issues.push('检测到重复页面，停止翻页'); break; }
        seenSignatures.add(signature);
        const ids = await fillAnswerPage(summary);
        showAnswerSummary(summary, '处理中…');
        if (!allPages || answerState.stop) break;
        if (ids.length >= answerState.entries.size && ids.every(id => answerState.entries.has(id))) break;
        const next = quizPager('next');
        if (!next) break;
        next.click();
        if (!await waitQuizTurn(signature, path)) { summary.issues.push('翻到下一页后未检测到新题目，停止'); break; }
      }
    } catch (e) { summary.issues.push('自动填写异常：' + String(e).slice(0, 110)); }
    finally {
      answerState.active = false;
      quizJob.answerBusy = false;
      setAnswerButtons(false);
      showAnswerSummary(summary, answerState.stop ? '已按要求停止，未自动交卷。' : '完成，未自动交卷。');
      note('answer fill: ' + summary.filled.size + ' new, ' + summary.already.size +
        ' already, ' + summary.issues.length + ' issues, pages=' + summary.pages);
    }
  }

  function answerTemplate() {
    const questions = readAnswerQuestions();
    if (!questions.length) { answerTextStatus('当前页面无法识别题目，不能生成带题干的模板'); return; }
    const txt = [
      '# LabSafe 答案模板 v1 —— 将 ? 替换为答案，保留 | 后的原题干',
      '# 判断题：对 / 错；单选：A/B/C...；多选：ACD；不确定保留 ?。',
      '# 导入时会用 | 后的题干核对当前试卷，防止换卷后错填。',
      ...questions.map(q => `${q.id}=?|${q.stem}`), '',
    ].join('\n');
    const blob = new Blob(['\uFEFF' + txt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url;
    a.download = 'LabSafe_Answers_Template.txt';
    document.body.appendChild(a);
    a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    answerTextStatus('已下载当前页 ' + questions.length + ' 题的答案模板。把文件中的问号改为答案，保留分隔符后的题干。');
  }

  $('#answerChoose').addEventListener('click', () => $('#answerFile').click());
  $('#answerFile').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (answerState.active) return;
    if (file.size > 1024 * 1024) { answerTextStatus('文件超过 1 MB，请只上传答案文本'); return; }
    try {
      const parsed = parseAnswers(await file.text());
      answerState.entries = parsed.entries;
      answerState.errors = parsed.errors;
      answerState.duplicates = parsed.duplicates;
      note('imported answers: ' + parsed.entries.size + ', errors=' + parsed.errors.length);
      previewAnswers();
    } catch (error) { answerTextStatus('无法读取答案文件：' + String(error)); }
  });
  $('#answerPreview').addEventListener('click', previewAnswers);
  $('#answerFillPage').addEventListener('click', () => { void runAnswerFill(false); });
  $('#answerFillAll').addEventListener('click', () => { void runAnswerFill(true); });
  $('#answerStop').addEventListener('click', () => { answerState.stop = true; answerTextStatus('正在停止自动填写，不会自动交卷。'); });
  $('#answerTemplate').addEventListener('click', answerTemplate);
  $('#answerStatus').textContent = '导入本地答案（TXT 或 JSON），核对匹配后点击填写。交卷由用户操作。';

  updateQuizTools();
  setInterval(updateQuizTools, 1800);

  // 单独识别并处理空闲提示，自动播放暂停时也继续运行。
  const idlePromptClicks = new WeakMap();
  function idleFallback() {
    if (!MERGE_CONFIG.idleDialogFallback) return;
    for (const dialog of document.querySelectorAll('.ivu-modal,[role="dialog"],[role="alertdialog"]')) {
      if (!visible(dialog)) continue;
      const text = (dialog.textContent || '').replace(/\s+/g, '');
      if (text.includes('是否跳转到微课堂')) continue;
      const study = /\u4f60\u5df2\u7ecf\u5728\u6b64\u9875\u9762\d+\u5206\u949f\u4e86/.test(text) &&
        text.includes('是否继续');
      const exam = text.includes('未进行答题') && text.includes('退出');
      if (!study && !exam) continue;
      if (Date.now() - (idlePromptClicks.get(dialog) || 0) < 5000) continue;
      const labels = exam
        ? /^(\u7ee7\u7eed\u8003\u8bd5|\u7ee7\u7eed\u7b54\u9898|\u7ee7\u7eed|\u786e\u5b9a)$/
        : /^(\u7ee7\u7eed\u5b66\u4e60|\u7ee7\u7eed|\u786e\u5b9a)$/;
      if (confirmModal(dialog, labels)) {
        idlePromptClicks.set(dialog, Date.now());
        note('handled idle prompt: ' + (exam ? 'exam' : 'study'));
      }
    }
  }
  let observedTime = '', lastTimeChange = 0, lastWakeClick = 0;
  function watchdogStudyTimer() {
    if (!MERGE_CONFIG.watchdogSeconds || document.hidden) return;
    const timer = document.querySelector('.alredyTime');
    if (!timer) return;
    const current = (timer.textContent || '').trim();
    if (!/^\d{2}:\d{2}:\d{2}$/.test(current)) return;
    if (current !== observedTime) {
      observedTime = current;
      lastTimeChange = Date.now();
      return;
    }
    if (Date.now() - lastTimeChange < MERGE_CONFIG.watchdogSeconds * 1000 ||
        Date.now() - lastWakeClick < 5 * 60000) return;
    lastWakeClick = Date.now();
    for (const button of document.querySelectorAll('button')) {
      if (!visible(button) || !/^(\u7ee7\u7eed\u5b66\u4e60|\u5f00\u59cb\u5b66\u4e60|\u518d\u6b21\u5b66\u4e60)$/.test(button.textContent.trim())) continue;
      button.click();
      note('study stopwatch watchdog clicked');
      break;
    }
  }
  paintTime();
  fetchTime(true);
  setInterval(() => fetchTime(false), 1000);
  setInterval(watchdogStudyTimer, 5000);
  setInterval(idleFallback, 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) fetchTime(true);
  });
  window.addEventListener('pageshow', () => fetchTime(true));



  function documents(root = document, result = [], seen = new Set()) {
    if (seen.has(root)) return result;
    seen.add(root);
    result.push(root);
    for (const frame of root.querySelectorAll('iframe')) {
      try {
        if (visible(frame) && frame.contentDocument) documents(frame.contentDocument, result, seen);
      } catch (_) { /* 跨域播放器无法直接访问。 */ }
    }
    return result;
  }

  function visible(element) {
    const view = element.ownerDocument.defaultView;
    if (!view || !element.isConnected || element.closest('[hidden],[aria-hidden="true"]')) return false;
    const style = view.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' &&
      element.getClientRects().length > 0;
  }

  function stop(message, pauseVideos = true) {
    state.running = false;
    sessionStorage.removeItem('sdu-autoplay-running');
    $('#toggle').textContent = '开始';
    if (pauseVideos) {
      for (const doc of documents()) {
        for (const video of doc.querySelectorAll('video')) {
          // 仅暂停本脚本已经接管的播放器。
          if (state.media.has(video) && !video.paused) video.pause();
        }
      }
    }
    status(message);
    $('#health').textContent = '已停止；点击开始后恢复。';
  }

  // 冻结期间任何页面脚本都不能执行。恢复后记录间隔，避免误判为视频卡死。
  function heartbeat() {
    const now = Date.now();
    const gap = now - state.lastTick;
    state.lastTick = now;
    if (gap > 20000) {
      state.gap = Math.round(gap / 1000);
      state.blocked = null;
      state.transition && (state.transition.at = now);
      sessionStorage.setItem('sdu-autoplay-gap', String(state.gap));
    }
    if (now - state.lastPersist > 10000) {
      state.lastPersist = now;
      sessionStorage.setItem('sdu-autoplay-last-tick', String(now));
    }
    $('#health').textContent = `${document.hidden ? '后台' : '前台'} · 自动播放已开启` +
      (state.gap ? ` · 最近调度中断 ${state.gap} 秒（可能休眠或冻结）` : ' · 未检测到长时间调度中断') +
      (sessionStorage.getItem('sdu-autoplay-platform-error') ? ' · 平台曾报参数错误，学时保存需核实' : '');
  }

  function queueTick() {
    if (!state.running || state.queue) return;
    state.queue = true;
    queueMicrotask(() => { state.queue = false; void tick(); });
  }

  function watchVideo(video) {
    if (state.watched.has(video)) return;
    state.watched.add(video);
    let last = 0;
    video.addEventListener('timeupdate', () => {
      if (Date.now() - last < 2000) return;
      last = Date.now();
      queueTick();
    });
    for (const event of ['ended', 'canplay', 'loadedmetadata', 'error', 'stalled']) {
      video.addEventListener(event, queueTick);
    }
  }

  function recover(key, message, delay = 90000) {
    const now = Date.now();
    if (!state.blocked || state.blocked.key !== key) state.blocked = { key, at: now };
    const remaining = Math.ceil((delay - (now - state.blocked.at)) / 1000);
    if (remaining > 0) { status(`${message}；自动重试中，${remaining} 秒后尝试刷新。`); return; }
    let attempts;
    try { attempts = JSON.parse(sessionStorage.getItem('sdu-autoplay-reloads') || '[]'); }
    catch (_) { attempts = []; }
    attempts = Array.isArray(attempts) ? attempts.filter(t => Number.isFinite(t) && now - t < 15 * 60000) : [];
    if (attempts.length >= 3 || (attempts.length && now - attempts[attempts.length - 1] < 120000)) {
      status(`${message}；暂缓刷新以免反复中断记录，将继续重试。`);
      return;
    }
    attempts.push(now);
    sessionStorage.setItem('sdu-autoplay-reloads', JSON.stringify(attempts));
    sessionStorage.setItem('sdu-autoplay-last-recovery', message);
    if (key === 'platform-parameter-error') sessionStorage.removeItem('sdu-autoplay-parameter-errors');
    status(`${message}；正在刷新恢复，保持自动播放开启。`);
    location.reload();
    return true;
  }

  function findNext(docs) {
    // 实际微课堂目录：当前课时的子元素有 chapteractive。
    const items = [...document.querySelectorAll('li.classItem')];
    const index = items.findIndex(item => item.querySelector('.chapteractive'));
    if (index < 0 || index + 1 >= items.length) return null;
    const button = items[index + 1].querySelector('button.studybtn');
    return button && !button.disabled ? button : null;
  }

  function seconds(text) {
    const value = (text || '').trim();
    if (!/^\d+:\d{2}(?::\d{2})?$/.test(value)) return NaN;
    return value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  }

  function courseName(item) {
    return (item?.querySelector('.itemTitle')?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function isContinuePrompt(text) {
    const compact = (text || '').replace(/\s+/g, '');
    return /你已经在此页面\d+分钟了/.test(compact) &&
      compact.includes('秒后自动退出') && compact.includes('是否继续');
  }

  function confirmModal(modal, labels = /^(确定|继续|继续学习)$/) {
    const button = [...modal.querySelectorAll('button')].find(b =>
      labels.test(b.textContent.trim()) &&
      !b.disabled && b.getAttribute('aria-disabled') !== 'true' && visible(b));
    if (!button) return false;
    const previous = state.modalClicks.get(modal);
    if (previous !== undefined && Date.now() - previous < 1000) return true;
    state.modalClicks.set(modal, Date.now());
    button.click();
    return true;
  }

  function parameterErrors() {
    try {
      const values = JSON.parse(sessionStorage.getItem('sdu-autoplay-parameter-errors') || '[]');
      return Array.isArray(values) ? values.filter(t => Number.isFinite(t) && Date.now() - t < 120000) : [];
    } catch (_) { return []; }
  }

  function trainingNext() {
    const items = [...document.querySelectorAll('li.panelItem')];
    const index = items.findIndex(item => item.classList.contains('activeitem'));
    if (index < 0) { recover('training-active', '未能定位培训课程'); return; }
    if (index + 1 < items.length) {
      state.transition = { from: courseName(items[index]), at: Date.now() };
      state.lastNext = Date.now();
      items[index + 1].click();
      status('正在切换培训课程……');
      return;
    }
    // 培训目录使用 iView 的无限滚动容器，先触发加载后再寻找下一项。
    const scroll = items[index].closest('.ivu-scroll-container');
    if (scroll && (!state.loadAt || Date.now() - state.loadAt < 15000)) {
      if (!state.loadAt) state.loadAt = Date.now();
      scroll.scrollTop = scroll.scrollHeight;
      status('正在加载后续培训目录……');
      return;
    }
    recover('training-tail', '后续培训目录尚未加载');
  }

  function handleArticle() {
    const active = document.querySelector('li.panelItem.activeitem');
    if (!active) {
      const first = document.querySelector('li.panelItem');
      if (first && location.pathname.match(/^\/lab-study-front\/trainTask\/\d+\//) && Date.now() - state.lastNext > 6000) {
        state.lastNext = Date.now();
        first.click();
        status('原课程已移出未学目录，正在打开当前目录的首节课程。');
        return;
      }
      const go = [...document.querySelectorAll('.ivu-table-tbody button')].find(b =>
        b.textContent.trim() === '去学习' && !b.disabled && visible(b));
      if (go && Date.now() - state.lastNext > 6000) {
        state.lastNext = Date.now();
        go.click();
        status('正在打开课程表中第一节待学习课程。');
      } else recover('training-empty', '等待培训课程目录加载');
      return;
    }
    if (!state.articles) {
      status('当前是图文/幻灯片课程。阅读后可启用“图文达到页面要求时切换”。');
      return;
    }
    const key = courseName(active);
    if (state.articleKey !== key) {
      state.articleKey = key;
      state.articleDoneAt = 0;
      state.loadAt = 0;
    }
    const learned = seconds(document.querySelector('.positionRight .alredyTime')?.textContent);
    const required = seconds(document.querySelector('.positionRight .allTime')?.textContent);
    if (!Number.isFinite(learned) || !Number.isFinite(required) || required <= 0) {
      recover(`article-timer:${key}`, '等待平台学习计时器加载');
      return;
    }
    status(`图文学习：${learned} / ${required} 秒（使用平台显示的计时）`);
    if (learned < required) {
      state.articleDoneAt = 0;
      recover(`article:${key}:${learned}`, `图文学习：${learned} / ${required} 秒`, 120000);
      return;
    }
    state.blocked = null;
    if (!state.next) { stop('本节已达到页面要求时长。'); return; }
    if (!state.articleDoneAt) state.articleDoneAt = Date.now();
    if (Date.now() - state.articleDoneAt >= 5000) trainingNext();
  }

  async function tick() {
    if (!state.running || state.busy) return;
    state.busy = true;
    try {
      heartbeat();
      // 题目页面暂停播放器恢复与课程导航。
      if (quizJob.active || isQuizPage() || /cg-exam/i.test(location.pathname)) {
        status('练习/考试页面：仅保留学时更新与题目导出');
        return;
      }
      const docs = documents();
      // 反复错误可能来自平台记录请求，正常播放不能证明学时已保存。
      if (parameterErrors().length >= 3) {
        if (recover('platform-parameter-error', '平台持续返回请求参数错误，尝试刷新课程恢复', 0)) return;
      }
      const modal = docs.flatMap(doc => [...doc.querySelectorAll(
        '.ivu-modal,[role="dialog"],[role="alertdialog"],dialog[open]'
      )]).find(visible);
      if (modal && modal.querySelector('.ivu-modal-confirm-body')?.textContent.trim() === '请求参数错误') {
        const previous = state.modalClicks.get(modal);
        if (confirmModal(modal) && (previous === undefined || Date.now() - previous >= 1000)) {
          const errors = parameterErrors();
          errors.push(Date.now());
          sessionStorage.setItem('sdu-autoplay-parameter-errors', JSON.stringify(errors));
          sessionStorage.setItem('sdu-autoplay-platform-error', '请求参数错误');
          status('已关闭请求参数错误提示；视频继续播放，连续报错时将有限刷新恢复。');
        }
        return;
      }
      if (modal && modal.textContent.includes('是否跳转到微课堂学习')) {
        if (state.navigationAt && Date.now() - state.navigationAt < 8000) {
          status('已确认进入微课堂，等待页面跳转……');
          return;
        }
        const active = document.querySelector('li.panelItem.activeitem');
        const items = [...document.querySelectorAll('li.panelItem')];
        // 在点击侧栏时记录的视频条目优先于仍停留在旧课的 activeitem。
        const selected = state.clickedTraining || {
          url: location.pathname, index: items.indexOf(active), name: courseName(active),
          nextName: courseName(items[items.indexOf(active) + 1])
        };
        sessionStorage.setItem('sdu-autoplay-return', JSON.stringify(selected));
        if (confirmModal(modal)) state.navigationAt = Date.now();
        status('正在进入微课堂……');
        return;
      }
      if (modal && isContinuePrompt(modal.textContent) && confirmModal(modal)) {
        status('已自动确认继续学习，保持静音播放。');
        return;
      }
      if (modal && /视频(?:已经|已)?学习完[，,]?是否重新学习/.test(modal.textContent.replace(/\s+/g, '')) && confirmModal(modal)) {
        state.transition = null;
        status('已自动确认重新学习，继续静音播放。');
        return;
      }
      if (modal && modal.textContent.includes('平台学习时长查看指南') && confirmModal(modal)) {
        status('已关闭学习时长说明，继续播放。');
        return;
      }
      if (modal && /视频(?:已经|已)?播放完毕[，,]?请(?:选择|播放)其他视频/.test(modal.textContent.replace(/\s+/g, ''))) {
        if (!state.endedModals.has(modal)) state.endedModals.set(modal, Date.now());
        if (Date.now() - state.endedModals.get(modal) < 4000) {
          status('视频已结束，等待平台保存进度后返回……');
          return;
        }
        const saved = JSON.parse(sessionStorage.getItem('sdu-autoplay-return') || 'null');
        const returnURL = saved ? new URL(saved.url, location.origin) : null;
        const fromTraining = returnURL && returnURL.origin === location.origin &&
          /^\/lab-study-front\/trainTask\/\d+\//.test(returnURL.pathname);
        if (fromTraining) {
          // 实测“确定”会返回培训页，先保存待切换状态，防止返回后丢失流程。
          sessionStorage.setItem('sdu-autoplay-return-done', 'yes');
          if (confirmModal(modal)) status('已处理视频结束提示，返回培训页继续下一课。');
        } else {
          // 独立微课堂播放时，“取消”关闭提示并保留目录，随后由 ended 分支切课。
          if (confirmModal(modal, /^取消$/)) status('已关闭视频结束提示，准备下一课。');
        }
        return;
      }

      if (state.transition && document.querySelector('li.panelItem.activeitem')) {
        const name = courseName(document.querySelector('li.panelItem.activeitem'));
        if (name === state.transition.from) {
          if (Date.now() - state.transition.at > 15000) {
            recover('training-transition', '课程切换尚未成功');
          }
          return;
        }
        state.transition = null;
        state.articleDoneAt = 0;
        state.loadAt = 0;
        return; // 下一轮再读取新课计时，避免旧计时残留。
      }

      if (location.pathname.includes('/trainTask/') && sessionStorage.getItem('sdu-autoplay-return-done') === 'yes') {
        const saved = JSON.parse(sessionStorage.getItem('sdu-autoplay-return') || 'null');
        const items = [...document.querySelectorAll('li.panelItem')];
        if (saved && items.length) {
          if (!state.returnedAt) state.returnedAt = Date.now();
          if (Date.now() - state.returnedAt < 3000) {
            status('已返回培训页，等待课程信息加载后选择下一课……');
            return;
          }
          // 已完成条目会从目录移除，不能继续用返回前的固定序号。
          let target = null;
          if (saved.nextName) {
            const matching = items.filter(item => courseName(item) === saved.nextName);
            if (matching.length === 1) target = matching[0];
          } else if (courseName(items[saved.index]) === saved.name) {
            target = items[saved.index + 1]; // 兼容上一版保留的上下文。
          }
          if (target) {
            sessionStorage.removeItem('sdu-autoplay-return');
            sessionStorage.removeItem('sdu-autoplay-return-done');
            state.lastNext = Date.now();
            state.transition = null;
            target.click();
            return;
          }
          const pending = items.find(item => courseName(item) === saved.name) || items[0];
          sessionStorage.removeItem('sdu-autoplay-return');
          sessionStorage.removeItem('sdu-autoplay-return-done');
          state.clickedTraining = null;
          state.lastNext = Date.now();
          pending.click();
          status('目录已更新，正在打开仍待学习的课程。');
          return;
        }
      }

      const videos = docs.flatMap(doc => [...doc.querySelectorAll('video')]).filter(visible);
      // 优先选择面积最大的可见播放器，避免播放页面上的小视频。
      videos.sort((a, b) => {
        const x = a.getBoundingClientRect();
        const y = b.getBoundingClientRect();
        return y.width * y.height - x.width * x.height;
      });
      const video = videos[0];
      if (!video) {
        if (modal) {
          status('当前弹窗需要手动处理；自动播放仍保持开启。');
          return;
        }
        if (location.pathname.includes('/trainTask/')) handleArticle();
        else if (document.querySelector('#J_prismPlayer,li.classItem,.prism-player')) recover('player-missing', '等待视频播放器加载');
        else status('当前不是课程播放页面；学时刷新仍在进行。');
        return;
      }
      const currentLesson = document.querySelector('li.classItem .chapteritem_title.chapteractive')?.textContent.trim() || '';
      watchVideo(video);
      const source = `${video.currentSrc || video.src || ''}|${currentLesson}`;
      let record = state.media.get(video);
      if (!record || record.source !== source) {
        record = { source, advanced: false, endedAt: 0 };
        state.media.set(video, record);
      }
      if (video.error) {
        recover(`video-error:${source}`, '视频加载失败');
        return;
      }
      video.muted = true;
      video.defaultMuted = true;

      if (video.ended) {
        if (modal) {
          status('视频已结束，等待当前弹窗处理后再切换课程。');
          return;
        }
        if (!state.next) {
          stop('本节已播放结束。');
          return;
        }
        if (!record.endedAt) record.endedAt = Date.now();
        if (record.advanced) {
          recover(`video-transition:${source}`, '已点击下一课，等待新视频');
          return;
        }
        // 给平台留时间保存本节进度，再通过页面按钮切换。
        if (Date.now() - record.endedAt < 4000 || Date.now() - state.lastNext < 6000) {
          status('本节结束，等待平台保存进度……');
          state.blocked = null;
          return;
        }
        const saved = JSON.parse(sessionStorage.getItem('sdu-autoplay-return') || 'null');
        const returnURL = saved ? new URL(saved.url, location.origin) : null;
        if (returnURL && returnURL.origin === location.origin && /^\/lab-study-front\/trainTask\/\d+\//.test(returnURL.pathname)) {
          record.advanced = true;
          sessionStorage.setItem('sdu-autoplay-return-done', 'yes');
          location.assign(returnURL.pathname);
          return;
        }
        const next = findNext(docs);
        if (!next) {
          stop('视频已结束，当前微课堂目录没有下一课。');
          return;
        }
        record.advanced = true;
        state.lastNext = Date.now();
        next.click();
        status('已点击下一课，等待视频加载……');
        return;
      }

      record.endedAt = 0;
      record.advanced = false;
      if (video.playbackRate !== state.speed) video.playbackRate = state.speed;
      if (video.paused && video.readyState >= 2) {
        try {
          let playTimer;
          try {
            await Promise.race([video.play(), new Promise((_, reject) => {
              playTimer = setTimeout(() => reject(new Error('播放请求超时')), 8000);
            })]);
          } finally { clearTimeout(playTimer); }
          // 用户可能在 play() 尚未返回时点击了暂停。
          if (!state.running) { video.pause(); return; }
        } catch (error) {
          if (error.name === 'AbortError') return;
          if (error.name === 'NotAllowedError') stop('浏览器阻止播放：请先手动点一次视频播放，再点击开始。');
          else recover(`video-play:${source}`, '暂时无法启动视频');
          return;
        }
      }
      if (state.running) {
        if (modal) {
          state.blocked = null;
          status('有其他弹窗待处理，视频继续静音播放。');
        } else {
          // 观察真实播放头，不将脚本的运行时间当成平台学时。
          recover(`video-stall:${source}:${Math.floor(video.currentTime)}`, '视频播放头停滞', 120000);
          if (Date.now() - state.blocked.at < 30000) status(video.paused
            ? '等待视频缓冲……'
            : `正在静音自动播放（${video.playbackRate} 倍速）· 播放位置 ${Math.floor(video.currentTime)} 秒`);
        }
      }
    } catch (error) {
      console.warn('[山大课程自动播放]', error);
      recover('page-error', '页面暂时出现异常');
    } finally {
      state.busy = false;
    }
  }

  $('#toggle').addEventListener('click', () => {
    if (state.running) { stop('已暂停。'); return; }
    state.running = true;
    state.blocked = null;
    state.lastTick = Date.now();
    sessionStorage.setItem('sdu-autoplay-running', 'yes');
    $('#toggle').textContent = '暂停';
    status('正在检测播放器……');
    void tick();
  });
  $('#next').addEventListener('change', event => {
    state.next = event.target.checked;
    sessionStorage.setItem('sdu-autoplay-next', state.next ? 'yes' : 'no');
  });
  $('#articles').addEventListener('change', event => {
    state.articles = event.target.checked;
    sessionStorage.setItem('sdu-autoplay-articles', state.articles ? 'yes' : 'no');
  });
  $('#speed').addEventListener('change', event => {
    const speed = Number(event.target.value);
    if (!speeds.includes(speed)) return;
    state.speed = speed;
    sessionStorage.setItem('sdu-autoplay-speed', String(speed));
    if (state.running) {
      for (const doc of documents()) {
        for (const video of doc.querySelectorAll('video')) {
          if (state.media.has(video)) video.playbackRate = speed;
        }
      }
      void tick();
    }
  });
  document.addEventListener('click', event => {
    const item = event.target instanceof Element ? event.target.closest('li.panelItem') : null;
    if (!item || !state.running) return;
    state.clickedTraining = {
      url: location.pathname,
      index: [...document.querySelectorAll('li.panelItem')].indexOf(item),
      name: courseName(item),
      nextName: courseName(item.nextElementSibling?.matches('li.panelItem') ? item.nextElementSibling : null),
    };
  }, true);
  $('#details').hidden = sessionStorage.getItem('sdu-autoplay-folded') === 'yes';
  $('#fold').textContent = $('#details').hidden ? '展开' : '收起';
  $('#fold').addEventListener('click', () => {
    const details = $('#details');
    details.hidden = !details.hidden;
    sessionStorage.setItem('sdu-autoplay-folded', details.hidden ? 'yes' : 'no');
    $('#fold').textContent = details.hidden ? '展开' : '收起';
  });
  // 脚本不提交学习记录；学习进度由平台自己的播放器逻辑处理。
  // 倒计时只有 15 秒：弹窗出现时立即处理，定时轮询作为补充。
  let modalTickQueued = false;
  const modalObserver = new MutationObserver(records => {
    if (modalTickQueued) return;
    const related = records.some(record => {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (target?.closest('.ivu-modal,.ivu-modal-wrap,[role="dialog"],[role="alertdialog"]')) return true;
      return [...record.addedNodes].some(node => node instanceof Element &&
        (node.matches('.ivu-modal,.ivu-modal-wrap,[role="dialog"],[role="alertdialog"]') ||
         node.querySelector('.ivu-modal,[role="dialog"],[role="alertdialog"]')));
    });
    if (!related) return;
    modalTickQueued = true;
    setTimeout(() => {
      modalTickQueued = false;
      idleFallback();
      if (state.running) void tick();
    }, 0);
  });
  modalObserver.observe(document.body, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'open']
  });
  setInterval(() => { void tick(); }, 1000);
  document.addEventListener('visibilitychange', queueTick);
  window.addEventListener('pageshow', queueTick);
  window.addEventListener('online', queueTick);
  document.addEventListener('resume', queueTick);
  void tick();
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
})();
