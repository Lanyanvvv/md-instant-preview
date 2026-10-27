/**
 * Markdown 即时渲染预览 — 扩展入口
 * 
 * 注册自定义编辑器 Provider 和切换命令，
 * 兼容 VS Code、Cursor、Antigravity 等基于 VS Code 的编辑器。
 * 
 * 支持双击在预览/编辑模式间切换：
 * - 预览态双击 → 编辑态（跳转到对应行）
 * - 编辑态双击 → 预览态（滚动到对应位置）
 * 
 * v1.2 更新：
 * - 使用 webviewReady 握手机制，确保大文件切换时滚动消息
 *   在 DOM 完全就绪后才发送，解决长文档位置不同步问题。
 */
import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './markdownEditorProvider';

/**
 * 扩展激活时调用
 * 注册自定义 Markdown 编辑器和相关命令
 */
export function activate(context: vscode.ExtensionContext) {
  // 创建自定义 Markdown 编辑器 Provider 实例
  const provider = new MarkdownEditorProvider(context);

  // 注册 CustomTextEditorProvider
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      MarkdownEditorProvider.viewType,
      provider,
      {
        // 隐藏时保持 Webview 上下文，避免切换回来时重新渲染
        webviewOptions: {
          retainContextWhenHidden: true,
        },
        // 允许同一文档的多个编辑器实例
        supportsMultipleEditorsPerDocument: false,
      }
    )
  );

  // 注册"切换到编辑模式"命令 — 从渲染视图切换到文本编辑器
  context.subscriptions.push(
    vscode.commands.registerCommand('mdPreview.switchToEdit', () => {
      vscode.commands.executeCommand('workbench.action.reopenTextEditor');
    })
  );

  // 注册"切换到预览模式"命令 — 从文本编辑器切换回渲染视图
  context.subscriptions.push(
    vscode.commands.registerCommand('mdPreview.switchToPreview', () => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      if (uri) {
        const line = vscode.window.activeTextEditor?.selection.active.line ?? 0;

        // 先将滚动目标存储到 provider，Webview ready 后会自动发送
        provider.setPendingScroll(uri.toString(), line + 1); // 转为 1-indexed

        vscode.commands.executeCommand(
          'vscode.openWith',
          uri,
          MarkdownEditorProvider.viewType
        ).then(() => {
          // 作为备用方案，如果 webviewReady 握手在 retainContextWhenHidden 情况下
          // 不触发（Webview 已缓存），则延迟直接发送
          setTimeout(() => {
            const panel = provider.getWebviewPanel(uri.toString());
            if (panel) {
              panel.webview.postMessage({
                type: 'scrollToLine',
                line: line + 1,
              });
            }
          }, 500);
        });
      }
    })
  );

  // ========== 编辑态双击检测：双击切换回预览模式 ==========
  // 
  // VS Code 没有原生 "double click" 事件 API，
  // 但双击选词时会触发 onDidChangeTextEditorSelection，
  // 且 kind === Mouse，选中内容是一个完整单词（非空）。
  // 
  // 我们通过短时间间隔内连续两次鼠标选择事件来检测双击。

  /** 上一次鼠标选择事件的时间戳 */
  let lastMouseSelectionTime = 0;
  /** 上一次鼠标选择的行号 */
  let lastMouseSelectionLine = -1;
  /** 防抖标志：避免同一次双击多次触发 */
  let switchPending = false;

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      // 只处理 Markdown 文件
      if (e.textEditor.document.languageId !== 'markdown') {
        return;
      }

      // 只处理鼠标触发的选择变更（双击选词）
      if (e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) {
        return;
      }

      const now = Date.now();
      const currentLine = e.selections[0].active.line;
      const selection = e.selections[0];

      // 双击检测逻辑：
      // 1. 两次鼠标选择事件间隔在 500ms 以内
      // 2. 在同一行
      // 3. 第二次选择不为空（双击选中了一个单词）
      const timeDiff = now - lastMouseSelectionTime;
      const isSameLine = currentLine === lastMouseSelectionLine;
      const hasSelection = !selection.isEmpty;

      if (timeDiff < 500 && isSameLine && hasSelection && !switchPending) {
        // 检测到双击 — 切换回预览模式
        switchPending = true;
        const targetLine = currentLine + 1; // 转为 1-indexed
        const uri = e.textEditor.document.uri;

        // 先将滚动目标存储到 provider
        provider.setPendingScroll(uri.toString(), targetLine);

        // 短延迟，让双击选词完成后再切换，避免闪烁
        setTimeout(() => {
          vscode.commands.executeCommand(
            'vscode.openWith',
            uri,
            MarkdownEditorProvider.viewType
          ).then(() => {
            // 备用方案：如果 Webview 已缓存，webviewReady 不会重新触发
            setTimeout(() => {
              const panel = provider.getWebviewPanel(uri.toString());
              if (panel) {
                panel.webview.postMessage({
                  type: 'scrollToLine',
                  line: targetLine,
                });
              }
              switchPending = false;
            }, 500);
          });
        }, 100);
      }

      // 更新上一次选择的时间和行号
      lastMouseSelectionTime = now;
      lastMouseSelectionLine = currentLine;
    })
  );
}

/**
 * 扩展停用时调用
 */
export function deactivate() {}
