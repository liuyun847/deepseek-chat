/**
 * WebView 壳注入页面的补丁脚本。
 *
 * 怎么进页面：MainActivity.serveAsset 供 index.html 时，把
 * <script src="/shell.js" data-ds-shell></script> 插到 <head> 最前面 —— 经典同步脚本，
 * 一定先于 defer 的主包执行，所以首帧就能用上下面的 polyfill。onPageFinished 里还有一次
 * evaluateJavascript 注入作为兜底；本文件顶部有 window.__dsShell 闸门，重复执行直接返回。
 *
 * 放在独立文件而不是 Java 字符串常量里，一是省掉大量转义、二是这段 JS 可以单独读改。
 * 构建时由 tools/build-apk.ps1 从 android/shell/ 拷进 APK 的 assets/shell.js ——
 * 它不参与前端构建，dist/index.html 里也没有它（网页形态下没有这个文件，只有壳里才有）。
 *
 * 三件事，前两件都是 WebView 缺浏览器那一层能力、页面里补不了：
 *
 *   1. 返回键：前端是单页应用、没有 history 路由，系统返回键无从判断"该关哪个界面"。
 *      这里给原生一个 window.__dsBack()，从离用户最近的一层往外回退，返回 true 表示这次
 *      按键已被页面消费、false 表示页面没有可回退的层级（原生再决定 goBack 还是退出）：
 *        下拉浮层（Select 的 listbox、Menu 菜单）→ 弹窗（设置 / 导入覆盖 / 删除确认）→
 *        移动端抽屉（会话列表）→ 移动端会话详情页回会话列表
 *      只借页面自己的入口（派发与真实按键等效的 Esc、点前端自己的遮罩或按钮）改状态，
 *      不碰业务代码；判断不出可回退的层级时一律返回 false，绝不接管。
 *
 *   2. 旧 WebView 的运行时兜底：前端 bundle 的编译目标是 chrome >= 105（见
 *      rspack.config.ts 的 targets），只降语法、不注入 API polyfill，而本机雷电 9 的
 *      WebView 是 Chromium 91，缺下面这些方法（补丁必须在主包之前就位，原因见上）：
 *        Array.prototype.at   （ES2022 / Chrome 92）Modal 用它判断「谁在最上层」，缺了就在
 *                             keydown 处理器里抛 TypeError —— Esc 发出去却关不掉弹窗
 *        Object.hasOwn        （ES2022 / Chrome 93）App 渲染会话时用它判断 sessionCache
 *                             里有没有该 id，缺了会话页直接白屏
 *        String.prototype.at  （ES2022 / Chrome 92）与 Array 的 at 同一份实现
 *        Array.prototype.toReversed（ES2023 / Chrome 110）发送消息取上下文轮次时调用，
 *                             缺了发送流程在 prepareFiles 里抛 TypeError（界面只显示"上传失败"）
 *        Array.prototype.toSorted  （ES2023 / Chrome 110）导入历史解析消息树时调用，
 *                             缺了导入直接失败（「文件导入失败」）
 *      全部只在缺失时补，语义与标准一致（复制而非原地改，比较器与稳定排序保持一致）；
 *      现代 WebView 上一行都不执行。源码侧也同步改成 slice/sort 写法（见 store.ts、
 *      toLocal.ts），这一层只是给已经装了旧包、或者以后新代码再踩坑留的兜底。
 *
 *   3. 导出下载：设置里「导出全部对话」是 {URL.createObjectURL → <a download> → click()}。
 *      这个流程在浏览器里由下载管理器接管，WebView 没有下载管理器，点了什么都不会发生
 *      （DownloadListener 也拿不到 blob: 的内容 —— 它只活在渲染进程里）。
 *      所以这里在捕获阶段拦下带 download 属性的 blob: 链接，自己 fetch 出内容，
 *      读成 base64 交给原生走系统文件选择器落盘。
 */
(function () {
  if (window.__dsShell) return
  window.__dsShell = true

  // ── 旧 WebView 的运行时兜底（文件头第 2 条）────────────────────────────────

  /** 补 ES2022 的 at()：只在缺失时定义，负索引、越界语义与标准一致 */
  var defineAt = function (proto) {
    if (typeof proto.at === 'function') return
    Object.defineProperty(proto, 'at', {
      configurable: true,
      writable: true,
      value: function (index) {
        var length = this.length || 0
        var i = Math.trunc(Number(index)) || 0
        if (i < 0) i += length
        return i < 0 || i >= length ? undefined : this[i]
      },
    })
  }
  defineAt(Array.prototype)
  defineAt(String.prototype)

  if (typeof Object.hasOwn !== 'function') {
    Object.defineProperty(Object, 'hasOwn', {
      configurable: true,
      writable: true,
      value: function (object, key) {
        if (object === null || object === undefined) {
          throw new TypeError('Cannot convert undefined or null to object')
        }
        return Object.prototype.hasOwnProperty.call(Object(object), key)
      },
    })
  }

  /** 补 ES2023 的 toReversed()：返回倒序副本，原数组不动（slice 复制后再 reverse） */
  if (typeof Array.prototype.toReversed !== 'function') {
    Object.defineProperty(Array.prototype, 'toReversed', {
      configurable: true,
      writable: true,
      value: function () {
        return Array.prototype.slice.call(this).reverse()
      },
    })
  }

  /**
   * 补 ES2023 的 toSorted()：返回排序副本，原数组不动。
   * sort 自 ES2019 起就要求稳定排序，比较器参数与结果顺序与原生 toSorted 一致；
   * 不传比较器时等价于默认字典序排序（与原生相同）。
   */
  if (typeof Array.prototype.toSorted !== 'function') {
    Object.defineProperty(Array.prototype, 'toSorted', {
      configurable: true,
      writable: true,
      value: function (compare) {
        return Array.prototype.slice.call(this).sort(compare)
      },
    })
  }

  // ── 返回键 ────────────────────────────────────────────────────────────────

  /** 最上层弹窗：Modal 渲染成 [role="dialog"]，叠放时后打开的排在文档后面 */
  var topDialog = function () {
    var list = document.querySelectorAll('[role="dialog"]')
    return list.length ? list[list.length - 1] : null
  }

  /**
   * 派发一次 Esc。事件目标是当前焦点元素（真实按键就是这样），而不是 document 本身：
   * 派在 document 上走的是「目标阶段」，document 上的监听器不分捕获/冒泡都会执行，
   * Select 那套 captureEscape + stopPropagation「只关自己浮层、不连带关弹窗」就失效了。
   *
   * @returns {boolean} 事件是否真的派发成功（拿到 KeyboardEvent 构造器才能构造）
   */
  var pressEscape = function () {
    var target = document.activeElement || document.body
    var event
    try {
      event = new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
        which: 27,
        bubbles: true,
        cancelable: true,
      })
    } catch (e) {
      return false
    }
    target.dispatchEvent(event)
    return true
  }

  /** 点弹窗遮罩关闭它：Modal 的遮罩用 onMouseDown，且要求 event.target === currentTarget */
  var clickOverlay = function (dialog) {
    var overlay = dialog.parentElement
    if (!overlay) return
    try {
      overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    } catch (e) {
      // 兜底失败也无妨：这次按键仍算已消费，弹窗开着时用户还可以点 × 关闭
    }
  }

  /**
   * 页面侧的返回键入口，由 MainActivity.onBackPressed 用 evaluateJavascript 调用。
   *
   * @returns {boolean} true = 这次返回键已被页面消费；false = 页面没有可回退的层级
   */
  window.__dsBack = function () {
    // 层 1：下拉浮层（Select 的 listbox、Menu 菜单）盖在弹窗之上，先关它
    if (document.querySelector('[role="listbox"],[role="menu"]')) return pressEscape()

    // 层 2：弹窗（设置、导入覆盖确认、删除确认…）。Esc 交给 Modal 自己处理，只关最上层。
    var dialog = topDialog()
    if (dialog) {
      if (!pressEscape()) return false
      // Esc 发出去却没关掉（旧 WebView 上就踩过：Modal 的处理函数抛了 TypeError）时兜底：
      // 放到 setTimeout 里再看一眼，还挂着就点遮罩。必须异步 —— React 的状态更新是异步
      // 刷新的，同一轮里 isConnected 必然还是 true，此时补点遮罩会把两层界面一起关掉。
      window.setTimeout(function () {
        if (dialog.isConnected) clickOverlay(dialog)
      }, 0)
      return true
    }

    // 层 3：移动端抽屉（会话列表）开着 → 点遮罩收起，与用户点空白处同一个入口
    var mask = document.querySelector('[class*="drawerMask-"]')
    if (mask) {
      mask.click()
      return true
    }

    // 层 4：移动端会话详情页 → 回会话列表（打开抽屉）。
    // 判据是顶栏同时有「打开边栏」和「开启新对话」两个按钮：只有会话详情页会渲染后者；
    // 新对话页没有上一层，落到最后 return false，由原生退出应用。
    var menu = document.querySelector(
      'button[aria-label="打开边栏"],button[aria-label="Open sidebar"]'
    )
    var fresh = document.querySelector(
      'button[aria-label="开启新对话"],button[aria-label="New chat"]'
    )
    if (menu && fresh) {
      menu.click()
      return true
    }

    return false
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
