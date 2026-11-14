/**
 * WebView 壳注入页面的补丁脚本（由 MainActivity 在 onPageFinished 时读取并执行）。
 *
 * 放在独立文件而不是 Java 字符串常量里，一是省掉大量转义、二是这段 JS 可以单独读改。
 * 构建时由 tools/build-apk.ps1 从 android/shell/ 拷进 APK 的 assets/shell.js ——
 * 它不参与前端构建，也不被 index.html 引用（不会被浏览器请求，只由原生读取）。
 *
 * 只做两件事，都因为 WebView 缺浏览器的那一层能力：
 *   1. 返回键：前端是单页应用、没有 history 路由，系统返回键无从判断"该关哪个界面"。
 *      这里给原生一个 window.__dsBack()：最上层弹窗存在就派发 Esc（Modal 组件监听
 *      document 上的 keydown，Esc 关最上层），返回 true 表示已消费；否则返回 false，原生退出。
 *   2. 导出下载：设置里「导出全部对话」是 {URL.createObjectURL → <a download> → click()}。
 *      这个流程在浏览器里由下载管理器接管，WebView 没有下载管理器，点了什么都不会发生
 *      （DownloadListener 也拿不到 blob: 的内容 —— 它只活在渲染进程里）。
 *      所以这里在捕获阶段拦下带 download 属性的 blob: 链接，自己 fetch 出内容，
 *      读成 base64 交给原生走系统文件选择器落盘。
 */
(function () {
  if (window.__dsShell) return
  window.__dsShell = true

  window.__dsBack = function () {
    if (!document.querySelector('[role="dialog"]')) return false
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return true
  }

  /** 把 blob 读成 base64（跨 JNI 只能传基本类型，字符串是最省事的一种） */
  var toBase64 = function (blob, onDone, onFail) {
    var reader = new FileReader()
    reader.onload = function () {
      var data = String(reader.result)
      var comma = data.indexOf(',')
      onDone(comma < 0 ? '' : data.slice(comma + 1), blob.type)
    }
    reader.onerror = function () {
      onFail('读取导出内容失败')
    }
    reader.readAsDataURL(blob)
  }

  document.addEventListener(
    'click',
    function (event) {
      var target = event.target
      var anchor = target && target.closest ? target.closest('a[download]') : null
      if (!anchor || !anchor.href || anchor.href.indexOf('blob:') !== 0) return
      event.preventDefault()
      event.stopPropagation()

      var name = anchor.download || 'export.bin'
      fetch(anchor.href)
        .then(function (response) {
          return response.blob()
        })
        .then(function (blob) {
          toBase64(
            blob,
            function (base64, mime) {
              window.__DS_BRIDGE__.saveBase64(name, mime || 'application/octet-stream', base64)
            },
            function (message) {
              window.__DS_BRIDGE__.toast(message)
            }
          )
        })
        .catch(function () {
          window.__DS_BRIDGE__.toast('导出失败：读不到文件内容')
        })
    },
    true
  )
})()
