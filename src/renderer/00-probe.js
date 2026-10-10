/* eslint-disable */
/**
 * 00-probe.js —— 启动耗时探针，**必须排在所有脚本的最前面**（见 index.html）。
 *
 * 它要回答的问题是：`physics.js` 里打到的 `physics-start=226ms` 里，究竟有多少是
 * 「HTML 解析 + 渲染进程/preload 启动」这种躲不掉的开销，有多少是
 * `vendor/matter.min.js`（83 KB）的下载与编译。
 *
 * 只有一个自定义脚本排在它前面，所以 `00-probe.js` 自己的执行时刻 ≈
 * 「导航开始 → HTML 解析完 → 第一个脚本开始跑」，也就是把那 226ms 切一刀。
 * 剩下的差值（226 − probe-start）才是 vendor 脚本的代价。
 *
 * 结论用途（2026-10-07 实测，见 README）：
 *   · 如果 probe-start 本身就很靠后 → 大头在渲染进程启动 / preload，改脚本没用；
 *   · 如果 226 − probe-start 很大 → 值得对 vendor 做点什么（合并、压缩、延迟）。
 *
 * 本文件只做计时、只写一个全局数组，**不参与任何功能**，删掉不影响程序行为
 * （只是 RBOOT 那行日志会少两个点）。
 */
(function () {
  var MARKS = [];
  window.__pbRLine = MARKS;
  window.__pbRMark = function (name) {
    MARKS.push(name + '=' + Math.round(performance.now()) + 'ms');
  };
  window.__pbRMark('probe-start');

  // 资源计时：等 load 之后能拿到每个 <script src> 的 responseEnd，
  // 用来把"脚本下载/编译"从"执行"里分出来。
  window.addEventListener('load', function () {
    try {
      var rs = performance.getEntriesByType('resource');
      for (var i = 0; i < rs.length; i++) {
        var u = String(rs[i].name).split('/').pop();
        MARKS.push('res:' + u + '=' + Math.round(rs[i].startTime) + '..' +
                   Math.round(rs[i].responseEnd) + 'ms');
      }
      var nav = performance.getEntriesByType('navigation')[0];
      if (nav) {
        MARKS.push('nav:respEnd=' + Math.round(nav.responseEnd) + 'ms');
        MARKS.push('nav:domInteractive=' + Math.round(nav.domInteractive) + 'ms');
        MARKS.push('nav:domContentLoaded=' + Math.round(nav.domContentLoadedEventEnd) + 'ms');
      }
    } catch (e) { /* 计时失败不影响功能 */ }
    window.__pbRMark('load-end');
  });
})();