/**
 * Markdown 预览 Webview 脚本
 * 
 * 处理双击切换、内容更新、代码复制、位置同步等交互逻辑。
 * 运行在 Webview 的隔离环境中，通过 postMessage 与扩展宿主通信。
 * 
 * v1.2 更新：
 * - 新增 webviewReady 握手：DOM 就绪后通知扩展端，
 *   确保 scrollToLine 消息在 DOM 完全渲染后才被处理。
 */
(function () {
  'use strict';

  // 获取 VS Code API 实例（Webview 环境下可用）
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  // ========== 辅助函数：获取元素对应的源码行号 ==========

  /**
   * 从双击位置向上查找最近的 data-source-line 属性
   * 这个属性在渲染时被注入到块级 HTML 元素上
   * @param {Element} element - 被双击的 DOM 元素
   * @returns {number} 源码行号（1-indexed），找不到时使用滚动估算
   */
  function findSourceLine(element) {
    var current = element;
    while (current && current !== document.body) {
      // 检查当前元素是否有 data-source-line 属性
      if (current.getAttribute && current.getAttribute('data-source-line')) {
        var baseLine = parseInt(current.getAttribute('data-source-line'), 10) || 1;

        // 如果双击的是列表项、段落等有子内容的元素，
        // 尝试根据双击在元素内的垂直位置做微调
        // （同一个块级元素可能跨越多行源码）
        return baseLine;
      }
      // 向父级查找
      current = current.parentElement;
    }
    // 如果没找到，尝试根据滚动位置和可见元素估算行号
    return estimateLineFromPosition(element);
  }

  /**
   * 根据元素在页面中的位置估算对应的源码行号
   * 当双击位置没有 data-source-line 属性时使用
   * 
   * 改进策略：不再简单按滚动百分比估算，而是找到
   * 视口中最近的带行号标记的元素来推算
   * @param {Element} clickedElement - 被点击的元素
   * @returns {number} 估算的行号
   */
  function estimateLineFromPosition(clickedElement) {
    var container = document.getElementById('markdown-body');
    if (!container) { return 1; }

    // 获取被点击位置的 Y 坐标
    var clickY = 0;
    if (clickedElement && clickedElement.getBoundingClientRect) {
      clickY = clickedElement.getBoundingClientRect().top;
    } else {
      // 退化到使用滚动位置
      clickY = 0;
    }

    // 获取所有带行号标记的元素
    var lineElements = container.querySelectorAll('[data-source-line]');
    if (lineElements.length === 0) { return 1; }

    // 找到离点击位置最近的带行号元素
    var bestElement = null;
    var bestDistance = Infinity;

    for (var i = 0; i < lineElements.length; i++) {
      var el = lineElements[i];
      var rect = el.getBoundingClientRect();
      var elCenter = rect.top + rect.height / 2;
      var distance = Math.abs(elCenter - clickY);

      if (distance < bestDistance) {
        bestDistance = distance;
        bestElement = el;
      }
    }

    if (bestElement) {
      return parseInt(bestElement.getAttribute('data-source-line'), 10) || 1;
    }

    // 最终退化：使用滚动百分比
    var scrollTop = document.documentElement.scrollTop || document.body.scrollTop;
    var scrollHeight = document.documentElement.scrollHeight || document.body.scrollHeight;
    var clientHeight = document.documentElement.clientHeight || document.body.clientHeight;
    var scrollPercent = scrollHeight > clientHeight
      ? scrollTop / (scrollHeight - clientHeight)
      : 0;

    var lastLine = parseInt(
      lineElements[lineElements.length - 1].getAttribute('data-source-line'),
      10
    ) || 1;

    return Math.max(1, Math.round(scrollPercent * lastLine));
  }

  // ========== 双击切换到编辑模式（携带行号信息） ==========
  document.addEventListener('dblclick', function (e) {
    // 排除代码复制按钮上的双击
    var target = /** @type {Element} */ (e.target);
    if (target && target.closest && target.closest('.copy-btn')) {
      return;
    }

    // 获取双击位置对应的源码行号
    var sourceLine = findSourceLine(/** @type {Element} */ (e.target));

    // 通知扩展宿主切换到文本编辑器，传递行号
    vscode.postMessage({
      type: 'switchToEditor',
      line: sourceLine,
    });
  });

  // ========== 接收来自扩展的消息 ==========
  window.addEventListener('message', function (event) {
    var message = event.data;
    switch (message.type) {
      case 'update':
        // 内容更新 — 保持滚动位置
        var container = document.getElementById('markdown-body');
        if (container) {
          var scrollTop =
            document.documentElement.scrollTop || document.body.scrollTop;
          container.innerHTML = message.html;
          // 恢复滚动位置
          document.documentElement.scrollTop = scrollTop;
          document.body.scrollTop = scrollTop;
          // 重新添加代码复制按钮
          addCopyButtons();
        }
        break;

      case 'scrollToLine':
        // 从编辑态切换回预览态时，滚动到对应行
        scrollToSourceLine(message.line);
        break;
    }
  });

  // ========== 位置同步：滚动到指定源码行对应的 DOM 位置 ==========

  /**
   * 滚动到指定源码行号对应的 HTML 元素位置
   * 
   * 改进策略：如果精确行号没有对应元素，
   * 则在前后两个有标记的元素之间做线性插值，
   * 计算更精确的滚动位置。
   * 
   * @param {number} targetLine - 目标行号（1-indexed）
   */
  function scrollToSourceLine(targetLine) {
    if (!targetLine || targetLine <= 0) { return; }

    var container = document.getElementById('markdown-body');
    if (!container) { return; }

    // 找到所有带 data-source-line 的元素
    var lineElements = container.querySelectorAll('[data-source-line]');
    if (lineElements.length === 0) { return; }

    // 找到目标行前后最近的两个标记元素
    var prevElement = null;
    var prevLine = 0;
    var nextElement = null;
    var nextLine = Infinity;

    for (var i = 0; i < lineElements.length; i++) {
      var el = lineElements[i];
      var line = parseInt(el.getAttribute('data-source-line'), 10);
      if (isNaN(line)) { continue; }

      if (line <= targetLine && line > prevLine) {
        prevLine = line;
        prevElement = el;
      }
      if (line > targetLine && line < nextLine) {
        nextLine = line;
        nextElement = el;
      }
      // 精确匹配
      if (line === targetLine) {
        prevElement = el;
        prevLine = line;
        break;
      }
    }

    // 如果没找到任何元素
    if (!prevElement && !nextElement) {
      if (lineElements.length > 0) {
        prevElement = lineElements[0];
      } else {
        return;
      }
    }

    var scrollTarget;

    if (prevLine === targetLine || !nextElement) {
      // 精确匹配或只有前方元素：直接滚动到该元素
      scrollTarget = prevElement;
    } else if (!prevElement) {
      // 只有后方元素
      scrollTarget = nextElement;
    } else {
      // 在两个标记元素之间做线性插值
      var prevRect = prevElement.getBoundingClientRect();
      var nextRect = nextElement.getBoundingClientRect();
      var fraction = (targetLine - prevLine) / (nextLine - prevLine);
      var interpolatedY = prevRect.top + fraction * (nextRect.top - prevRect.top);

      // 直接滚动到插值位置（居中显示）
      var viewportHeight = window.innerHeight;
      var absoluteY = interpolatedY + window.scrollY - viewportHeight / 2;
      window.scrollTo({
        top: Math.max(0, absoluteY),
        behavior: 'smooth',
      });

      // 高亮最近的元素
      prevElement.classList.add('source-line-highlight');
      setTimeout(function () {
        prevElement.classList.remove('source-line-highlight');
      }, 1500);
      return;
    }

    if (scrollTarget) {
      // 平滑滚动到目标元素，并让它显示在视口中部
      scrollTarget.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });

      // 添加高亮闪烁动画，帮助用户定位
      scrollTarget.classList.add('source-line-highlight');
      setTimeout(function () {
        scrollTarget.classList.remove('source-line-highlight');
      }, 1500);
    }
  }

  // ========== 代码块复制功能 ==========

  /**
   * 为所有代码块添加复制按钮
   */
  function addCopyButtons() {
    var blocks = document.querySelectorAll('pre');
    for (var i = 0; i < blocks.length; i++) {
      var pre = blocks[i];
      // 避免重复添加
      if (pre.querySelector('.copy-btn')) {
        continue;
      }

      // 为 pre 设置相对定位（复制按钮绝对定位在右上角）
      pre.style.position = 'relative';

      // 创建复制按钮
      var btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.textContent = '复制';
      btn.title = '复制代码到剪贴板';

      // 绑定点击事件（使用闭包捕获 pre 引用）
      btn.addEventListener(
        'click',
        (function (currentPre, currentBtn) {
          return function (e) {
            e.stopPropagation();
            e.preventDefault();
            var code = currentPre.querySelector('code');
            if (code) {
              vscode.postMessage({
                type: 'copyCode',
                text: code.textContent || '',
              });
              // 按钮反馈动画
              currentBtn.textContent = '已复制 ✓';
              currentBtn.classList.add('copied');
              setTimeout(function () {
                currentBtn.textContent = '复制';
                currentBtn.classList.remove('copied');
              }, 2000);
            }
          };
        })(pre, btn)
      );

      pre.appendChild(btn);
    }
  }

  // ========== 编辑提示动画 ==========

  /**
   * 显示"双击编辑"提示，3秒后自动消失
   */
  function showEditHint() {
    var hint = document.getElementById('edit-hint');
    if (hint) {
      // 延迟显示，让页面先渲染完成
      setTimeout(function () {
        hint.classList.add('show');
      }, 500);
      // 3秒后隐藏
      setTimeout(function () {
        hint.classList.remove('show');
      }, 4000);
    }
  }

  // ========== 初始化 ==========
  addCopyButtons();
  showEditHint();

  // 通知扩展端：Webview DOM 已就绪
  // 这使得扩展端可以在此之后安全地发送 scrollToLine 消息
  vscode.postMessage({ type: 'webviewReady' });
})();
