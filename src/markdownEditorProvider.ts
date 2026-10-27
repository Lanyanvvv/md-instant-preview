/**
 * Markdown 自定义编辑器 Provider
 * 
 * 使用 CustomTextEditorProvider API 实现 Markdown 文件的即时渲染预览。
 * 基于 marked.js 解析 Markdown，highlight.js 实现代码高亮。
 * 支持双击在预览/编辑模式间切换，并保持位置同步。
 * 
 * 行号注入方案（v1.2 重构）：
 * 使用 marked 的 lexer 获取精确的 token 列表，根据每个 token 的 raw 文本
 * 在原始 Markdown 中精确定位行号，然后在渲染后的 HTML 中按 token 顺序
 * 注入 data-source-line 属性。相比旧版「Markdown 行扫描 + HTML 正则配对」
 * 的方式，完全消除了长文档中的累积偏移问题。
 */
import * as vscode from 'vscode';
import { Marked, Token, TokensList } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';

/**
 * 用于计算 Markdown 源码中某个字符偏移量（offset）对应的行号。
 * 预先构建行首偏移量表，使查找复杂度为 O(log n)。
 */
class LineMapper {
  /** 每行首字符在原始文本中的偏移量（0-indexed） */
  private lineStarts: number[];

  constructor(text: string) {
    this.lineStarts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') {
        this.lineStarts.push(i + 1);
      }
    }
  }

  /**
   * 将字符偏移量转换为行号（1-indexed）
   * 使用二分查找实现 O(log n) 复杂度
   */
  getLine(offset: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo + 1; // 转为 1-indexed
  }
}

/**
 * 存储一个块级元素的行号信息
 */
interface BlockLineInfo {
  /** 对应的 HTML 标签名（如 p, h1, pre, li, table, blockquote, hr） */
  tag: string;
  /** 在 Markdown 源码中的起始行号（1-indexed） */
  line: number;
}

/**
 * 从 marked 的 token 列表中提取所有块级元素的行号信息。
 * 利用 token.raw 在原始 Markdown 中精确定位每个元素的起始位置。
 * 
 * 这是修复长文档行号偏移的核心函数：
 * - 旧方案：独立扫描 Markdown 行 → 收集块起始行 → 用正则匹配 HTML 标签 → 按序配对
 *   问题：Markdown 块数量 ≠ HTML 标签数量（嵌套列表、表格内部标签等导致偏移累积）
 * - 新方案：使用 marked 的 lexer 输出精确 token → 每个 token.raw 在原文中查找位置 → 得到精确行号
 *   → 知道每个 token 会生成什么 HTML 标签 → 按已知的标签顺序注入行号
 */
function extractBlockLines(tokens: TokensList | Token[], markdownText: string, lineMapper: LineMapper): BlockLineInfo[] {
  const result: BlockLineInfo[] = [];
  let searchOffset = 0;

  // 使用栈管理搜索偏移，支持嵌套结构
  // 进入嵌套时保存当前偏移，退出时恢复
  const offsetStack: number[] = [];

  /**
   * 在原文中查找 token.raw 的位置，返回行号
   * @param raw - token 的原始文本
   * @param parentLine - 父元素的行号（当搜索失败时用作回退值）
   * @param parentOffset - 父元素在原文中的偏移量（限定搜索范围）
   */
  function findTokenLine(raw: string, parentLine: number = 1, parentOffset: number = -1): number {
    if (!raw) { return parentLine; }
    // 用 raw 的前 80 字符搜索
    const searchKey = raw.substring(0, Math.min(80, raw.length));
    
    // 从当前搜索偏移开始查找
    const idx = markdownText.indexOf(searchKey, searchOffset);
    if (idx >= 0) {
      searchOffset = idx + 1; // 推进偏移，+1 避免同一位置重复匹配
      return lineMapper.getLine(idx);
    }
    
    // 如果从当前偏移没找到，尝试从父元素偏移开始找
    if (parentOffset >= 0) {
      const idx2 = markdownText.indexOf(searchKey, parentOffset);
      if (idx2 >= 0) {
        return lineMapper.getLine(idx2);
      }
    }

    // 最终退化：尝试全文搜索
    const idxFallback = markdownText.indexOf(searchKey);
    if (idxFallback >= 0) {
      return lineMapper.getLine(idxFallback);
    }
    
    // 完全找不到时继承父元素行号
    return parentLine;
  }

  /**
   * 查找 raw 文本在原文中的字符偏移量
   * 用于给子元素搜索提供起始偏移
   */
  function findRawOffset(raw: string): number {
    if (!raw) { return 0; }
    const searchKey = raw.substring(0, Math.min(80, raw.length));
    const idx = markdownText.indexOf(searchKey, Math.max(0, searchOffset - 1));
    if (idx >= 0) { return idx; }
    const idx2 = markdownText.indexOf(searchKey);
    return idx2 >= 0 ? idx2 : 0;
  }

  function walk(tokenList: Token[], parentLine: number = 1, parentOffset: number = -1) {
    for (const token of tokenList) {
      switch (token.type) {
        case 'heading': {
          const line = findTokenLine(token.raw, parentLine, parentOffset);
          const depth = (token as any).depth || 1;
          result.push({ tag: `h${depth}`, line });
          break;
        }

        case 'paragraph': {
          // 对于 blockquote 内的 paragraph，raw 不含 > 前缀
          // 需要在父 blockquote 范围内搜索
          let line: number;
          if (parentOffset >= 0) {
            // 在父元素的 raw 范围内搜索
            // paragraph 的 raw 文本前面可能被 blockquote 的 > 前缀去掉了
            // 所以用 raw 的内容在父元素偏移之后的范围中查找
            const searchKey = token.raw.substring(0, Math.min(60, token.raw.length)).trim();
            const idx = markdownText.indexOf(searchKey, parentOffset);
            if (idx >= 0) {
              line = lineMapper.getLine(idx);
            } else {
              line = parentLine;
            }
          } else {
            line = findTokenLine(token.raw, parentLine, parentOffset);
          }
          result.push({ tag: 'p', line });
          break;
        }

        case 'code': {
          const line = findTokenLine(token.raw, parentLine, parentOffset);
          result.push({ tag: 'pre', line });
          break;
        }

        case 'blockquote': {
          const rawOffset = findRawOffset(token.raw);
          const line = findTokenLine(token.raw, parentLine, parentOffset);
          result.push({ tag: 'blockquote', line });
          // blockquote 内部子 token 的 raw 不含 > 前缀
          // 传递父偏移量和行号
          if ((token as any).tokens) {
            const savedOffset = searchOffset;
            walk((token as any).tokens, line, rawOffset);
            // 恢复搜索偏移到 blockquote 结束后
            searchOffset = Math.max(searchOffset, savedOffset);
          }
          break;
        }

        case 'list': {
          const rawOffset = findRawOffset(token.raw);
          const line = findTokenLine(token.raw, parentLine, parentOffset);
          const ordered = (token as any).ordered;
          result.push({ tag: ordered ? 'ol' : 'ul', line });
          
          if ((token as any).items) {
            for (const item of (token as any).items) {
              // list_item 的 raw 包含 "- " 前缀，可以在列表范围内搜索
              const itemLine = findTokenLine(item.raw, line, rawOffset);
              result.push({ tag: 'li', line: itemLine });
              
              // 列表项内部可能有嵌套的段落、子列表等
              if (item.tokens) {
                const itemOffset = findRawOffset(item.raw);
                const savedOffset = searchOffset;
                walk(item.tokens, itemLine, itemOffset);
                // 嵌套结构结束后恢复搜索偏移
                searchOffset = Math.max(searchOffset, savedOffset);
              }
            }
          }
          break;
        }

        case 'table': {
          const line = findTokenLine(token.raw, parentLine, parentOffset);
          result.push({ tag: 'table', line });
          break;
        }

        case 'hr': {
          const line = findTokenLine(token.raw, parentLine, parentOffset);
          result.push({ tag: 'hr', line });
          break;
        }

        case 'html': {
          const line = findTokenLine(token.raw, parentLine, parentOffset);
          const match = token.raw.match(/^<(\w+)/);
          if (match) {
            result.push({ tag: match[1].toLowerCase(), line });
          }
          break;
        }

        // space 类型跳过（空行）
        // 其他内联类型不处理
      }
    }
  }

  walk(tokens as Token[]);
  return result;
}

/**
 * 将行号信息注入到渲染后的 HTML 中。
 * 按照 HTML 中块级标签的出现顺序，与 blockLines 列表配对注入。
 * 
 * 精确性保证：因为 blockLines 是从 marked 的 token 列表中按深度优先顺序
 * 提取的，而 marked 的 parser 也是按同样的深度优先顺序输出 HTML，
 * 所以两者的顺序完全一致。
 */
function injectLineNumbers(html: string, blockLines: BlockLineInfo[]): string {
  let lineIndex = 0;

  // 匹配所有块级开始标签
  // 包含：h1-h6, p, pre, blockquote, li, table, hr, ul, ol, div
  const blockTagPattern = /(<(?:p|h[1-6]|pre|blockquote|li|table|hr|ul|ol|div))([\s>\/])/gi;

  const result = html.replace(blockTagPattern, (match, tagStart: string, afterTag: string) => {
    // 提取标签名
    const tagName = tagStart.substring(1).toLowerCase();

    // 从 blockLines 中找到对应的行号
    // 简单策略：顺序配对（因为 token 顺序 = HTML 输出顺序）
    if (lineIndex < blockLines.length) {
      const info = blockLines[lineIndex];
      // 验证标签名匹配（如果不匹配则向前查找）
      if (info.tag === tagName) {
        lineIndex++;
        return `${tagStart} data-source-line="${info.line}"${afterTag}`;
      }
      // 标签不匹配时：可能是 marked 生成了额外的包装标签
      // 向前搜索找到匹配的标签
      for (let j = lineIndex; j < blockLines.length && j < lineIndex + 3; j++) {
        if (blockLines[j].tag === tagName) {
          const line = blockLines[j].line;
          lineIndex = j + 1;
          return `${tagStart} data-source-line="${line}"${afterTag}`;
        }
      }
      // 仍然没找到匹配，使用当前行号（总比没有好）
      const fallbackLine = blockLines[lineIndex].line;
      lineIndex++;
      return `${tagStart} data-source-line="${fallbackLine}"${afterTag}`;
    }
    return match;
  });

  return result;
}

/**
 * 创建配置好的 Marked 实例
 * 集成 highlight.js 代码高亮 + GFM 扩展
 */
function createMarkedInstance(): Marked {
  const instance = new Marked(
    markedHighlight({
      langPrefix: 'hljs language-',
      highlight(code: string, lang: string) {
        if (lang && hljs.getLanguage(lang)) {
          return hljs.highlight(code, { language: lang }).value;
        }
        return hljs.highlightAuto(code).value;
      },
    })
  );

  instance.setOptions({
    gfm: true,
    breaks: false,
  });

  return instance;
}

export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  /** 自定义编辑器的唯一标识符 */
  public static readonly viewType = 'mdPreview.markdownEditor';

  /** Marked 解析器实例 */
  private readonly marked: Marked;

  /** 存储各文档对应的 WebviewPanel 引用，用于从编辑态切换回预览态时发送滚动消息 */
  private readonly webviewPanels = new Map<string, vscode.WebviewPanel>();

  /** 存储待发送的 scrollToLine 消息（等 Webview ready 后发送） */
  private readonly pendingScrollMessages = new Map<string, number>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.marked = createMarkedInstance();
  }

  /**
   * 获取某个文档对应的 WebviewPanel（供外部切换命令使用）
   */
  public getWebviewPanel(uri: string): vscode.WebviewPanel | undefined {
    return this.webviewPanels.get(uri);
  }

  /**
   * 设置待发送的滚动消息（Webview ready 后会自动发送）
   */
  public setPendingScroll(uri: string, line: number) {
    this.pendingScrollMessages.set(uri, line);
  }

  /**
   * 渲染 Markdown 文本为 HTML，精确注入源码行号标记
   * 
   * 流程：
   * 1. 用 marked.lexer() 生成 token 列表
   * 2. 从 token 列表中提取块级元素的精确行号
   * 3. 用 marked.parser() 将 token 渲染为 HTML
   * 4. 按顺序将行号注入到 HTML 的块级标签上
   */
  private renderMarkdownWithSourceLines(markdownText: string): string {
    const lineMapper = new LineMapper(markdownText);

    // 第一步：词法分析，获取 token 列表
    const tokens = this.marked.lexer(markdownText);

    // 第二步：从 token 列表中提取块级元素的行号
    const blockLines = extractBlockLines(tokens, markdownText, lineMapper);

    // 第三步：渲染 HTML
    const html = this.marked.parser(tokens);

    // 第四步：注入行号
    return injectLineNumbers(html, blockLines);
  }

  /**
   * 当 VS Code 需要显示自定义编辑器时调用
   * 负责设置 Webview 内容和事件监听
   */
  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    // 保存 WebviewPanel 引用（key 为文档 URI 字符串）
    const docKey = document.uri.toString();
    this.webviewPanels.set(docKey, webviewPanel);

    // 配置 Webview 选项
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };

    // 获取 Webview 资源 URI
    const styleUri = webviewPanel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'preview.css')
    );
    const scriptUri = webviewPanel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'preview.js')
    );

    /**
     * 完整更新 Webview HTML（用于首次渲染）
     */
    const updateWebview = () => {
      const markdownContent = document.getText();
      const htmlContent = this.renderMarkdownWithSourceLines(markdownContent);
      webviewPanel.webview.html = this.getHtmlForWebview(
        webviewPanel.webview,
        htmlContent,
        styleUri,
        scriptUri
      );
    };

    // 首次渲染
    updateWebview();

    // 监听文档变更 — 当文件在其他编辑器中被修改时同步更新渲染
    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(
      (e) => {
        if (e.document.uri.toString() === document.uri.toString()) {
          const markdownContent = document.getText();
          const htmlContent = this.renderMarkdownWithSourceLines(markdownContent);
          // 发送增量更新消息，避免重建整个 HTML
          webviewPanel.webview.postMessage({
            type: 'update',
            html: htmlContent,
          });
        }
      }
    );

    // 监听来自 Webview 的消息
    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'switchToEditor': {
          // 双击切换到文本编辑器，带上源码行号
          const targetLine = message.line || 1;
          
          // 先执行切换到文本编辑器
          await vscode.commands.executeCommand('workbench.action.reopenTextEditor');
          
          // 等待编辑器打开后跳转到对应行
          setTimeout(() => {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.uri.toString() === document.uri.toString()) {
              const lineIndex = Math.max(0, targetLine - 1);
              const clampedLine = Math.min(lineIndex, editor.document.lineCount - 1);
              const position = new vscode.Position(clampedLine, 0);
              editor.selection = new vscode.Selection(position, position);
              editor.revealRange(
                new vscode.Range(position, position),
                vscode.TextEditorRevealType.InCenter
              );
            }
          }, 150);
          break;
        }

        case 'webviewReady': {
          // Webview 的 DOM 已就绪，检查是否有待发送的滚动消息
          const pendingLine = this.pendingScrollMessages.get(docKey);
          if (pendingLine !== undefined) {
            this.pendingScrollMessages.delete(docKey);
            webviewPanel.webview.postMessage({
              type: 'scrollToLine',
              line: pendingLine,
            });
          }
          break;
        }

        case 'copyCode':
          // 复制代码块内容到剪贴板
          if (message.text) {
            vscode.env.clipboard.writeText(message.text);
            vscode.window.showInformationMessage('代码已复制到剪贴板');
          }
          break;
      }
    });

    // Webview 关闭时清理资源
    webviewPanel.onDidDispose(() => {
      changeDocumentSubscription.dispose();
      this.webviewPanels.delete(docKey);
      this.pendingScrollMessages.delete(docKey);
    });
  }

  /**
   * 构建完整的 Webview HTML
   * 包含 CSP 安全策略、样式、脚本和渲染后的 Markdown 内容
   */
  private getHtmlForWebview(
    webview: vscode.Webview,
    htmlContent: string,
    styleUri: vscode.Uri,
    scriptUri: vscode.Uri
  ): string {
    const nonce = this.getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" 
          content="default-src 'none'; 
                   style-src ${webview.cspSource} 'unsafe-inline'; 
                   script-src 'nonce-${nonce}'; 
                   img-src ${webview.cspSource} https: data:; 
                   font-src ${webview.cspSource};">
    <link href="${styleUri}" rel="stylesheet">
    <title>Markdown 预览</title>
</head>
<body>
    <div id="markdown-body" class="markdown-body">
        ${htmlContent}
    </div>
    <div id="edit-hint" class="edit-hint">
        <span class="edit-hint-icon">✏️</span>
        <span>双击任意位置进入编辑模式</span>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  /**
   * 生成随机 nonce 字符串，用于 CSP 内容安全策略
   */
  private getNonce(): string {
    let text = '';
    const possible =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
