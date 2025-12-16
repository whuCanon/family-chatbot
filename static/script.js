const loginOverlay = document.getElementById('login-overlay');
const appContainer = document.getElementById('app-container');
const passwordInput = document.getElementById('password-input');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const chatContainer = document.getElementById('chat-container');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const modelSelect = document.getElementById('model-select');
const sidebarNewChatBtn = document.getElementById('sidebar-new-chat-btn');
const toggleSidebarBtn = document.getElementById('toggle-sidebar-btn');
const closeSidebarBtn = document.getElementById('close-sidebar-btn');
const sidebar = document.getElementById('history-sidebar');
const historyList = document.getElementById('history-list');

// Image Upload Elements
const uploadTriggerBtn = document.getElementById('upload-trigger-btn');
const imageUploadInput = document.getElementById('image-upload-input');
const imagePreviewContainer = document.getElementById('image-preview-container');

// State
let messageHistory = [];
let currentConversationId = null;
let conversations = [];
let selectedImages = [];
let currentAbortController = null; // 用于取消流式请求
let isGenerating = false; // 标记是否正在生成回复
let currentAiContentDiv = null; // 当前正在生成的AI消息DOM元素
let currentFullResponse = ''; // 当前已生成的完整响应内容

// === Lightbox State ===
const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');
let currentSessionImages = [];
let currentLightboxIndex = -1;

// === Enhanced Markdown Rendering Configuration ===
// Configure marked for better rendering
marked.setOptions({
    gfm: true,           // GitHub Flavored Markdown
    breaks: true,        // Convert \n to <br>
    headerIds: false,    // Disable auto-generated header IDs
    mangle: false,       // Don't mangle email addresses
    smartypants: true,   // Use smart quotes and dashes
});

// === Mermaid 配置 ===
// 初始化 Mermaid，使用暗色主题匹配应用风格
mermaid.initialize({
    startOnLoad: false,  // 禁用自动渲染，我们手动控制
    theme: 'dark',
    themeVariables: {
        primaryColor: '#6366f1',
        primaryTextColor: '#f8fafc',
        primaryBorderColor: '#4f46e5',
        lineColor: '#94a3b8',
        secondaryColor: '#1e293b',
        tertiaryColor: '#0f172a',
        background: '#0f172a',
        mainBkg: '#1e293b',
        nodeBorder: '#4f46e5',
        clusterBkg: '#1e293b',
        titleColor: '#f8fafc',
        edgeLabelBackground: '#1e293b',
    },
    flowchart: {
        htmlLabels: true,
        curve: 'basis',
    },
    sequence: {
        diagramMarginX: 20,
        diagramMarginY: 20,
        actorMargin: 50,
        width: 150,
        height: 65,
        boxMargin: 10,
        boxTextMargin: 5,
        noteMargin: 10,
        messageMargin: 35,
    },
    securityLevel: 'loose',  // 允许点击事件等交互
});

// Mermaid 图表计数器，用于生成唯一 ID
let mermaidCounter = 0;

// HTML 实体解码函数 - 将转义的 HTML 实体还原为原始字符
function decodeHtmlEntities(text) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = text;
    return textarea.value;
}

// Preprocess text to protect LaTeX math delimiters and Mermaid blocks from marked.js
// marked.js may consume or escape backslashes, breaking \[...\] and \(...\) delimiters
function preprocessMathDelimiters(text) {
    // Store math expressions and mermaid blocks, replace with placeholders
    const mathBlocks = [];

    // Protect display math: $$...$$ (already safe, but let's be consistent)
    // Protect display math: \[...\] - convert to $$...$$ temporarily
    // The regex handles multi-line content
    let processed = text;

    // FIRST: Protect mermaid code blocks (before any other processing)
    // Match ```mermaid ... ``` blocks
    processed = processed.replace(/```mermaid\n([\s\S]*?)```/g, (match, content) => {
        const placeholder = `%%MERMAID_${mathBlocks.length}%%`;
        mathBlocks.push({ type: 'mermaid', content: content.trim(), original: match });
        return placeholder;
    });

    // First, protect $$...$$ blocks (to avoid confusion)
    processed = processed.replace(/\$\$([\s\S]*?)\$\$/g, (match, content) => {
        const placeholder = `%%MATH_DISPLAY_${mathBlocks.length}%%`;
        mathBlocks.push({ type: 'display', content: content, original: match });
        return placeholder;
    });

    // Protect \[...\] display math (convert backslash-bracket to placeholder)
    processed = processed.replace(/\\\[([\s\S]*?)\\\]/g, (match, content) => {
        const placeholder = `%%MATH_DISPLAY_${mathBlocks.length}%%`;
        mathBlocks.push({ type: 'display', content: content, original: match });
        return placeholder;
    });

    // Protect $...$ inline math (single dollar, not escaped)
    // Be careful not to match currency like "$5" - require non-digit after opening $
    processed = processed.replace(/\$([^\$\n]+?)\$/g, (match, content) => {
        // Skip if it looks like currency (starts with digit or space+digit)
        if (/^\d/.test(content) || /^\s*\d/.test(content)) {
            return match;
        }
        const placeholder = `%%MATH_INLINE_${mathBlocks.length}%%`;
        mathBlocks.push({ type: 'inline', content: content, original: match });
        return placeholder;
    });

    // Protect \(...\) inline math
    processed = processed.replace(/\\\(([\s\S]*?)\\\)/g, (match, content) => {
        const placeholder = `%%MATH_INLINE_${mathBlocks.length}%%`;
        mathBlocks.push({ type: 'inline', content: content, original: match });
        return placeholder;
    });

    return { processed, mathBlocks };
}

// Restore math expressions and mermaid blocks after markdown processing
// For display math, we directly render using KaTeX with displayMode to ensure proper styling
function restoreMathDelimiters(html, mathBlocks) {
    let restored = html;
    mathBlocks.forEach((block, index) => {
        const displayPlaceholder = `%%MATH_DISPLAY_${index}%%`;
        const inlinePlaceholder = `%%MATH_INLINE_${index}%%`;
        const mermaidPlaceholder = `%%MERMAID_${index}%%`;

        if (block.type === 'mermaid') {
            // For mermaid, create a container with unique ID for later rendering
            mermaidCounter++;
            const mermaidId = `mermaid-${Date.now()}-${mermaidCounter}`;
            // 创建一个待渲染的 Mermaid 容器
            const wrappedHtml = `</p><div class="mermaid-container" data-mermaid-id="${mermaidId}"><div class="mermaid-source" style="display:none;">${escapeHtml(block.content)}</div><div class="mermaid-loading">正在渲染图表...</div></div><p>`;
            restored = restored.replace(mermaidPlaceholder, wrappedHtml);
        } else if (block.type === 'display') {
            // For display math, render directly with KaTeX and wrap in a container
            // This ensures the katex-display class is properly applied
            try {
                // 解码 HTML 实体，修复不等号等符号的乱码问题
                const decodedContent = decodeHtmlEntities(block.content);
                const renderedMath = katex.renderToString(decodedContent, {
                    displayMode: true,
                    throwOnError: false,
                    errorColor: '#ef4444',
                    trust: true,
                    strict: false,
                });
                // Wrap in a div with our custom class for additional styling
                const wrappedHtml = `</p><div class="math-display-block">${renderedMath}</div><p>`;
                restored = restored.replace(displayPlaceholder, wrappedHtml);
            } catch (e) {
                console.error('KaTeX render error:', e);
                restored = restored.replace(displayPlaceholder, `$$${block.content}$$`);
            }
        } else if (block.type === 'inline') {
            // For inline math, render directly with KaTeX
            try {
                // 解码 HTML 实体，修复不等号等符号的乱码问题
                const decodedContent = decodeHtmlEntities(block.content);
                const renderedMath = katex.renderToString(decodedContent, {
                    displayMode: false,
                    throwOnError: false,
                    errorColor: '#ef4444',
                    trust: true,
                    strict: false,
                });
                restored = restored.replace(inlinePlaceholder, renderedMath);
            } catch (e) {
                console.error('KaTeX render error:', e);
                restored = restored.replace(inlinePlaceholder, `$${block.content}$`);
            }
        }
    });
    return restored;
}

// HTML 转义函数，用于安全地存储 Mermaid 源码
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 渲染页面上所有待处理的 Mermaid 图表
async function renderMermaidDiagrams(container) {
    const mermaidContainers = container.querySelectorAll('.mermaid-container:not([data-rendered])');

    for (const containerDiv of mermaidContainers) {
        const sourceDiv = containerDiv.querySelector('.mermaid-source');
        const loadingDiv = containerDiv.querySelector('.mermaid-loading');

        if (!sourceDiv) continue;

        const mermaidCode = sourceDiv.textContent;
        const mermaidId = containerDiv.dataset.mermaidId;

        try {
            // 使用 mermaid.render 渲染 SVG
            const { svg } = await mermaid.render(mermaidId, mermaidCode);

            // 移除加载状态，插入渲染结果
            if (loadingDiv) loadingDiv.remove();
            sourceDiv.remove();

            // 创建渲染结果容器
            const resultDiv = document.createElement('div');
            resultDiv.className = 'mermaid-result';
            resultDiv.innerHTML = svg;
            containerDiv.appendChild(resultDiv);

            // 标记为已渲染
            containerDiv.dataset.rendered = 'true';

        } catch (error) {
            console.error('Mermaid render error:', error);

            // 显示错误信息
            if (loadingDiv) loadingDiv.remove();

            const errorDiv = document.createElement('div');
            errorDiv.className = 'mermaid-error';
            errorDiv.innerHTML = `
                <div class="mermaid-error-title">Mermaid 图表渲染失败</div>
                <code>${escapeHtml(error.message || '未知错误')}</code>
            `;
            containerDiv.appendChild(errorDiv);
            containerDiv.dataset.rendered = 'error';
        }
    }
}

// Render markdown with math support using KaTeX
function renderMarkdownWithMath(text, element) {
    // Preprocess to protect math from marked.js
    const { processed, mathBlocks } = preprocessMathDelimiters(text);

    // Parse markdown
    let html = marked.parse(processed);

    // Restore and render math expressions (KaTeX is applied during restore)
    html = restoreMathDelimiters(html, mathBlocks);

    // Clean up empty paragraphs that may result from display math extraction
    html = html.replace(/<p>\s*<\/p>/g, '');

    element.innerHTML = html;

    // Then, apply syntax highlighting to code blocks
    element.querySelectorAll('pre code').forEach((block) => {
        hljs.highlightElement(block);
    });

    // Render Mermaid diagrams (async, will update the DOM when ready)
    renderMermaidDiagrams(element);
}

// Simplified render for streaming updates (lighter weight)
function renderMarkdownStreaming(text, element) {
    // Preprocess to protect math from marked.js
    const { processed, mathBlocks } = preprocessMathDelimiters(text);

    // Parse markdown
    let html = marked.parse(processed);

    // Restore and render math expressions
    html = restoreMathDelimiters(html, mathBlocks);

    // Clean up empty paragraphs
    html = html.replace(/<p>\s*<\/p>/g, '');

    element.innerHTML = html;

    // Only highlight visible code blocks
    element.querySelectorAll('pre code:not(.hljs)').forEach((block) => {
        hljs.highlightElement(block);
    });
}

// Full render after stream completes - now simpler as math is pre-rendered
function finalizeMarkdownRender(element) {
    // Math is already rendered in restoreMathDelimiters, just ensure code highlighting is complete
    element.querySelectorAll('pre code:not(.hljs)').forEach((block) => {
        hljs.highlightElement(block);
    });

    // Render any pending Mermaid diagrams after stream completes
    renderMermaidDiagrams(element);
}

// Check Auth on Load
async function checkAuth() {
    try {
        const res = await fetch('/api/auth/check');
        const data = await res.json();
        if (data.authenticated) {
            showApp();
        }
    } catch (e) {
        console.error("Auth check failed", e);
    }
}
checkAuth();

// Login Logic
loginBtn.addEventListener('click', async () => {
    const password = passwordInput.value;
    if (!password) return;

    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        const data = await res.json();

        if (data.success) {
            showApp();
        } else {
            loginError.textContent = data.error || "Login failed";
        }
    } catch (e) {
        loginError.textContent = "Network error";
    }
});

passwordInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        loginBtn.click();
    }
});

function showApp() {
    loginOverlay.classList.add('hidden');
    appContainer.classList.remove('hidden');
    userInput.focus();
    loadHistory();
    startNewChat();
}

// Sidebar Logic
const sidebarOverlay = document.getElementById('sidebar-overlay');

function openSidebar() {
    sidebar.classList.add('open');
    if (sidebarOverlay && window.innerWidth <= 768) {
        sidebarOverlay.classList.add('active');
    }
}

function closeSidebar() {
    sidebar.classList.remove('open');
    if (sidebarOverlay) {
        sidebarOverlay.classList.remove('active');
    }
}

function toggleSidebar() {
    if (sidebar.classList.contains('open')) {
        closeSidebar();
    } else {
        openSidebar();
    }
    if (window.innerWidth > 768) {
        sidebar.classList.toggle('collapsed');
    }
}

toggleSidebarBtn.addEventListener('click', toggleSidebar);
closeSidebarBtn.addEventListener('click', closeSidebar);

// 点击遮罩层关闭侧边栏
if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', closeSidebar);
}

// History Management

function loadHistory() {
    const stored = localStorage.getItem('chat_history');
    if (stored) {
        conversations = JSON.parse(stored);
        // 数据清理：加载时也顺便检查一下是否有过期的
        cleanOldHistory();
    }
    renderHistoryList();
}

function cleanOldHistory() {
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const initialCount = conversations.length;
    conversations = conversations.filter(c => c.timestamp > thirtyDaysAgo);

    if (conversations.length !== initialCount) {
        saveHistory();
    }
}

function saveHistory() {
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    conversations = conversations.filter(c => c.timestamp > thirtyDaysAgo);

    try {
        localStorage.setItem('chat_history', JSON.stringify(conversations));
    } catch (e) {
        if (e.name === 'QuotaExceededError') {
            console.warn("Local storage full, removing oldest conversation...");
            // 如果满了，删除最后一条（最早的）记录，然后重试
            if (conversations.length > 0) {
                conversations.pop();
                saveHistory(); // 递归重试
            } else {
                console.error("Storage full and cannot be freed.");
            }
        } else {
            console.error("Failed to save history:", e);
        }
    }
    renderHistoryList();
}

function getRelativeDateLabel(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diffTime = Math.abs(now - date);
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 0 && now.getDate() === date.getDate()) {
        return "Today";
    } else if (diffDays === 1 || (diffDays === 0 && now.getDate() !== date.getDate())) {
        return "Yesterday";
    } else if (diffDays <= 7) {
        return "Previous 7 Days";
    } else if (diffDays <= 30) {
        return "Previous 30 Days";
    } else {
        return "Older";
    }
}

function renderHistoryList() {
    historyList.innerHTML = '';

    // 按时间倒序排序
    conversations.sort((a, b) => b.timestamp - a.timestamp);

    let currentLabel = null;

    conversations.forEach(conv => {
        const label = getRelativeDateLabel(conv.timestamp);

        // 插入日期标题
        if (label !== currentLabel) {
            currentLabel = label;
            const labelDiv = document.createElement('div');
            labelDiv.className = 'history-date-label';
            labelDiv.textContent = label;
            historyList.appendChild(labelDiv);
        }

        const div = document.createElement('div');
        div.className = `history-item ${conv.id === currentConversationId ? 'active' : ''}`;

        // 标题文本
        const span = document.createElement('span');
        span.textContent = conv.title || 'New Chat';
        div.appendChild(span);

        // 删除按钮
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-chat-btn';
        deleteBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
        deleteBtn.title = "Delete Chat";

        // 删除事件
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // 防止触发加载对话
            deleteConversation(conv.id);
        });

        div.appendChild(deleteBtn);

        // 点击加载对话
        div.addEventListener('click', () => loadConversation(conv.id));

        historyList.appendChild(div);
    });
}

function deleteConversation(id) {
    if (confirm("Are you sure you want to delete this conversation?")) {
        conversations = conversations.filter(c => c.id !== id);
        saveHistory();

        // 如果删除的是当前正在看的对话，重置界面
        if (id === currentConversationId) {
            startNewChat();
        }
    }
}

function renderThumbnail(container, url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = "Image";
    img.loading = "lazy"; // 懒加载

    // 收集图片到当前会话列表 (如果不重复)
    if (!currentSessionImages.includes(url)) {
        currentSessionImages.push(url);
    }

    img.onclick = () => openLightbox(url);
    container.appendChild(img);
}

function openLightbox(url) {
    // 重新扫描页面上的所有图片，确保顺序正确 (因为历史记录加载顺序可能不同)
    // 简单的做法是直接用 currentSessionImages，但为了点击时的即时性，
    // 我们可以在点击时查找 url 在数组中的位置
    currentLightboxIndex = currentSessionImages.indexOf(url);
    if (currentLightboxIndex === -1) {
        // 如果不在列表里（可能是新生成的），加进去
        currentSessionImages.push(url);
        currentLightboxIndex = currentSessionImages.length - 1;
    }

    updateLightboxImage();
    lightbox.classList.add('active');
}

function closeLightbox() {
    lightbox.classList.remove('active');
}

function updateLightboxImage() {
    if (currentLightboxIndex >= 0 && currentLightboxIndex < currentSessionImages.length) {
        lightboxImg.src = currentSessionImages[currentLightboxIndex];
    }
}

function changeLightboxImage(direction) {
    const newIndex = currentLightboxIndex + direction;
    if (newIndex >= 0 && newIndex < currentSessionImages.length) {
        currentLightboxIndex = newIndex;
        updateLightboxImage();
    }
}

// 统一的停止生成逻辑
function stopGeneration(savePartialResponse = true) {
    if (!isGenerating) return false;

    // 取消请求
    if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
    }

    // 如果有部分响应内容，保存到历史记录
    if (savePartialResponse && currentAiContentDiv && currentFullResponse) {
        // 添加重试按钮
        appendRetryButton(currentAiContentDiv);

        // 保存部分响应到历史
        messageHistory.push({ role: "assistant", content: currentFullResponse });
        updateCurrentConversation('assistant', currentFullResponse);
    }

    // 重置状态
    isGenerating = false;
    currentAiContentDiv = null;
    currentFullResponse = '';
    updateSendButtonState(false);

    return true;
}

// 更新发送按钮状态（发送/停止）
function updateSendButtonState(generating) {
    if (generating) {
        sendBtn.classList.add('stop-mode');
        sendBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" ry="2"/>
            </svg>
        `;
        sendBtn.title = "Stop generating";
        sendBtn.disabled = false;
    } else {
        sendBtn.classList.remove('stop-mode');
        sendBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
                stroke-linejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"></line>
                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
        `;
        sendBtn.title = "Send message";
        sendBtn.disabled = false;
    }
}

function startNewChat() {
    // 如果正在生成回复，先执行停止操作
    stopGeneration(true);

    currentSessionImages = [];

    currentConversationId = Date.now().toString();
    messageHistory = [];
    selectedImages = [];
    renderImagePreviews();
    chatContainer.innerHTML = '<div class="welcome-message"><h3>Hello!</h3><p>I\'m your AI assistant. Ask me anything or upload images.</p></div>';
    renderHistoryList();
}

function loadConversation(id) {
    // 如果正在生成回复，先执行停止操作
    stopGeneration(true);

    currentSessionImages = [];
    const conv = conversations.find(c => c.id === id);
    if (!conv) return;

    currentConversationId = id;
    messageHistory = JSON.parse(JSON.stringify(conv.messages));
    selectedImages = [];
    renderImagePreviews();
    chatContainer.innerHTML = '';

    messageHistory.forEach((msg, index) => {
        let isLastMsg = (index === messageHistory.length - 1);

        if (msg.role === 'user') {
            appendMessage('user', msg.content, false, index);
        } else if (msg.role === 'assistant') {
            let isImg = msg.isImage;

            if (!isImg && typeof msg.content === 'string') {
                isImg = !!msg.content.match(/^https?:\/\/.*(png|jpg|jpeg|webp)/i);
            }

            const { contentDiv: msgDiv } = appendMessage('ai', msg.content, isImg);

            if (isLastMsg && !isImg) {
                appendRetryButton(msgDiv);
            }
        }
    });

    if (window.innerWidth <= 768) {
        closeSidebar();
    }
    renderHistoryList();
}

// 提取添加重试按钮的逻辑
function appendRetryButton(contentDiv) {
    // 先检查是否已经存在
    if (contentDiv.querySelector('.message-toolbar')) return;

    const toolbar = document.createElement('div');
    toolbar.className = 'message-toolbar';

    // 复制按钮
    const copyBtn = document.createElement('button');
    copyBtn.className = 'toolbar-btn';
    copyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy';
    copyBtn.onclick = (e) => {
        e.stopPropagation();
        copyAiMessageContent(contentDiv);
    };

    // 重试按钮
    const regenBtn = document.createElement('button');
    regenBtn.className = 'toolbar-btn';
    regenBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M21 21v-5h-5"/></svg> Retry';
    regenBtn.onclick = () => regenerateLastMessage();

    toolbar.appendChild(copyBtn);
    toolbar.appendChild(regenBtn);
    contentDiv.appendChild(toolbar);
}

// 复制 AI 消息内容
function copyAiMessageContent(contentDiv) {
    // 获取纯文本内容（去除工具栏等）
    const clonedDiv = contentDiv.cloneNode(true);
    // 移除工具栏
    const toolbar = clonedDiv.querySelector('.message-toolbar');
    if (toolbar) toolbar.remove();

    // 获取文本内容
    const text = clonedDiv.innerText || clonedDiv.textContent;

    navigator.clipboard.writeText(text.trim()).then(() => {
        showToast('已复制到剪贴板');
    }).catch(err => {
        console.error('复制失败:', err);
        showToast('复制失败');
    });
}

function updateCurrentConversation(role, content, isImage = false) {
    let conv = conversations.find(c => c.id === currentConversationId);

    // 如果当前ID在列表里找不到（可能是新对话还没存），创建一个新的
    if (!conv) {
        conv = {
            id: currentConversationId,
            title: 'New Chat',
            messages: [],
            timestamp: Date.now()
        };
        conversations.unshift(conv); // 加到开头
    }

    // 如果是用户的第一条消息，异步生成标题
    if (role === 'user' && conv.messages.length === 0) {
        conv.title = 'New Chat';    // 先设置默认标题
        // 异步生成标题（不阻塞主流程）
        generateConversationTitle(content, conv.id);
    }

    // 更新消息列表
    // 再次注意：这里我们保存的是 messageHistory 的快照
    const msgObj = { role, content };
    if (isImage) msgObj.isImage = true;

    // 实时同步内存中的 history 到 storage 对象
    conv.messages = [...messageHistory];
    conv.timestamp = Date.now();

    // 重新排序：把当前对话移到最前
    conversations = conversations.filter(c => c.id !== currentConversationId);
    conversations.unshift(conv);

    saveHistory();
}

// 异步生成对话标题
async function generateConversationTitle(content, conversationId) {
    try {
        // 从 content 中提取纯文本
        let messageText = '';
        if (typeof content === 'string') {
            messageText = content;
        } else if (Array.isArray(content)) {
            messageText = content
                .filter(item => item.type === 'text')
                .map(item => item.text)
                .join(' ');
        }

        if (!messageText.trim()) {
            return; // 没有文本内容，跳过标题生成
        }

        const res = await fetch('/api/chat/generate-title', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: messageText })
        });

        if (!res.ok) {
            console.warn('Failed to generate title');
            return;
        }

        const data = await res.json();
        const newTitle = data.title || 'New Chat';

        // 更新对话标题
        const conv = conversations.find(c => c.id === conversationId);
        if (conv && conv.title === 'New Chat') {
            conv.title = newTitle;
            saveHistory();
            renderHistoryList();
        }
    } catch (e) {
        console.warn('Title generation error:', e);
    }
}

// Image Upload Logic
uploadTriggerBtn.addEventListener('click', () => {
    imageUploadInput.click();
});

imageUploadInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files);

    if (selectedImages.length + files.length > 9) {
        alert("You can upload a maximum of 9 images.");
        return;
    }

    selectedImages = [...selectedImages, ...files];
    renderImagePreviews();

    imageUploadInput.value = '';
});

function renderImagePreviews() {
    imagePreviewContainer.innerHTML = '';

    if (selectedImages.length === 0) {
        imagePreviewContainer.classList.add('hidden');
        return;
    }

    imagePreviewContainer.classList.remove('hidden');

    selectedImages.forEach((file, index) => {
        const item = document.createElement('div');
        item.className = 'preview-item';

        const img = document.createElement('img');
        img.src = URL.createObjectURL(file);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'preview-remove-btn';
        removeBtn.innerHTML = '✕';
        removeBtn.onclick = () => removeImage(index);

        item.appendChild(img);
        item.appendChild(removeBtn);
        imagePreviewContainer.appendChild(item);
    });
}

function removeImage(index) {
    selectedImages.splice(index, 1);
    renderImagePreviews();
}

async function uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData
    });

    if (!res.ok) throw new Error('Upload failed');
    const data = await res.json();
    return data.url; // 返回如 /images/cache/uuid.jpg
}

// Chat Logic

// 支持的标准图片格式
const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

// 检查是否是 HEIC/HEIF 格式
function isHeicFormat(file) {
    const fileName = file.name.toLowerCase();
    const fileType = file.type.toLowerCase();
    return fileType === 'image/heic' ||
        fileType === 'image/heif' ||
        fileName.endsWith('.heic') ||
        fileName.endsWith('.heif');
}

// 检查图片是否需要转换格式
function needsConversion(file) {
    // 如果是标准格式，不需要转换
    if (SUPPORTED_IMAGE_TYPES.includes(file.type)) {
        return false;
    }
    // HEIC/HEIF（iOS 常见格式）、BMP、TIFF 等需要转换
    return true;
}

// 使用 heic2any 库转换 HEIC/HEIF 格式
async function convertHeicToJpeg(file) {
    if (typeof heic2any === 'undefined') {
        throw new Error('heic2any library not loaded');
    }

    const blob = await heic2any({
        blob: file,
        toType: 'image/jpeg',
        quality: 0.92
    });

    // heic2any 可能返回数组（多帧 HEIC）或单个 blob
    const resultBlob = Array.isArray(blob) ? blob[0] : blob;

    const newFileName = file.name.replace(/\.[^/.]+$/, '.jpg');
    return new File([resultBlob], newFileName, {
        type: 'image/jpeg',
        lastModified: Date.now()
    });
}

// 使用 Canvas 将其他非标准格式图片转换为 JPEG
async function convertImageToJpegViaCanvas(file) {
    return new Promise((resolve, reject) => {
        // 创建 URL 对象
        const url = URL.createObjectURL(file);
        const img = new Image();

        img.onload = () => {
            try {
                // 创建 canvas
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');

                // 设置 canvas 尺寸
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;

                // 绘制图片到 canvas
                ctx.drawImage(img, 0, 0);

                // 转换为 JPEG blob
                canvas.toBlob((blob) => {
                    if (blob) {
                        // 创建新的 File 对象
                        const newFileName = file.name.replace(/\.[^/.]+$/, '.jpg');
                        const convertedFile = new File([blob], newFileName, {
                            type: 'image/jpeg',
                            lastModified: Date.now()
                        });
                        resolve(convertedFile);
                    } else {
                        reject(new Error('Failed to convert image'));
                    }
                }, 'image/jpeg', 0.92); // 0.92 是 JPEG 质量参数

            } catch (err) {
                reject(err);
            } finally {
                URL.revokeObjectURL(url);
            }
        };

        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('Failed to load image for conversion'));
        };

        img.src = url;
    });
}

// 处理图片文件，必要时进行格式转换
async function processImageFile(file) {
    if (!needsConversion(file)) {
        return file;
    }

    console.log(`Converting ${file.name} (${file.type || 'unknown type'}) to JPEG...`);

    try {
        let convertedFile;

        // HEIC/HEIF 格式使用专门的库转换
        if (isHeicFormat(file)) {
            console.log('Using heic2any for HEIC/HEIF conversion...');
            convertedFile = await convertHeicToJpeg(file);
        } else {
            // 其他格式尝试使用 Canvas 转换
            console.log('Using Canvas for image conversion...');
            convertedFile = await convertImageToJpegViaCanvas(file);
        }

        console.log(`Converted successfully to ${convertedFile.name}`);
        return convertedFile;
    } catch (err) {
        console.warn(`Failed to convert ${file.name}:`, err);
        // 转换失败时返回原文件，让后端处理或提示错误
        showToast(`图片格式转换失败: ${file.name}`);
        return file;
    }
}

// 辅助函数：将 File 对象转换为 Base64 字符串（支持格式转换）
async function fileToBase64(file) {
    // 先进行格式转换（如果需要）
    const processedFile = await processImageFile(file);

    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(processedFile); // 结果形如 data:image/jpeg;base64,...
        reader.onload = () => resolve(reader.result);
        reader.onerror = error => reject(error);
    });
}

function appendMessage(role, content, isImage = false, messageIndex = -1) {
    const div = document.createElement('div');
    div.className = `message ${role}`;

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = role === 'user' ? '👤' : '🤖';
    div.appendChild(avatar);

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    // 处理 Array 格式 (多模态)
    if (Array.isArray(content)) {
        content.forEach(item => {
            if (item.type === 'image_url') {
                const imgUrl = item.image_url.url;
                renderThumbnail(contentDiv, imgUrl);
            } else if (item.type === 'text') {
                const textDiv = document.createElement('div');
                renderMarkdownWithMath(item.text, textDiv);
                contentDiv.appendChild(textDiv);
            }
        });
    }
    // 处理单独的图片 URL (AI生成图)
    else if (isImage) {
        renderThumbnail(contentDiv, content);
    }
    // 纯文本
    else {
        renderMarkdownWithMath(content, contentDiv);
    }

    div.appendChild(contentDiv);

    // 用户消息的操作按钮容器（放在消息左侧）
    // 由于 message.user 使用 row-reverse，最后添加的元素会显示在左侧
    if (role === 'user') {
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'user-message-actions';

        // 存储原始内容供编辑功能使用
        div.dataset.messageIndex = messageIndex;
        div._originalContent = content;

        // 复制按钮
        const copyBtn = document.createElement('button');
        copyBtn.className = 'user-action-btn';
        copyBtn.title = '复制';
        copyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
        copyBtn.onclick = (e) => {
            e.stopPropagation();
            copyUserMessageText(div._originalContent);
        };

        // 编辑按钮
        const editBtn = document.createElement('button');
        editBtn.className = 'user-action-btn';
        editBtn.title = '编辑';
        editBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>';
        editBtn.onclick = (e) => {
            e.stopPropagation();
            enterEditMode(div, div._originalContent, parseInt(div.dataset.messageIndex));
        };

        actionsDiv.appendChild(copyBtn);
        actionsDiv.appendChild(editBtn);
        div.appendChild(actionsDiv);
    }

    if (role === 'assistant' && !isImage) {
        appendRetryButton(contentDiv);
    }

    chatContainer.appendChild(div);

    return { messageDiv: div, contentDiv: contentDiv };
}

// 从消息内容中提取纯文本
function extractTextFromContent(content) {
    if (typeof content === 'string') {
        return content;
    } else if (Array.isArray(content)) {
        return content
            .filter(item => item.type === 'text')
            .map(item => item.text)
            .join('\n');
    }
    return '';
}

// 复制用户消息文本
function copyUserMessageText(content) {
    const text = extractTextFromContent(content);
    navigator.clipboard.writeText(text).then(() => {
        // 可以添加一个简单的提示
        showToast('已复制到剪贴板');
    }).catch(err => {
        console.error('复制失败:', err);
    });
}

// 显示简单的 toast 提示
function showToast(message) {
    const existingToast = document.querySelector('.toast-message');
    if (existingToast) existingToast.remove();

    const toast = document.createElement('div');
    toast.className = 'toast-message';
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => toast.remove(), 300);
    }, 2000);
}

// 进入编辑模式
function enterEditMode(messageDiv, originalContent, messageIndex) {
    if (isGenerating) return; // 如果正在生成，不允许编辑

    const text = extractTextFromContent(originalContent);
    const contentDiv = messageDiv.querySelector('.message-content');
    const actionsDiv = messageDiv.querySelector('.user-message-actions');

    // 隐藏原内容和操作按钮
    contentDiv.style.display = 'none';
    if (actionsDiv) actionsDiv.style.display = 'none';

    // 创建编辑容器
    const editContainer = document.createElement('div');
    editContainer.className = 'edit-container';

    // 编辑输入框
    const editTextarea = document.createElement('textarea');
    editTextarea.className = 'edit-textarea';
    editTextarea.value = text;
    editTextarea.rows = Math.max(1, text.split('\n').length);

    // 按钮容器
    const editActions = document.createElement('div');
    editActions.className = 'edit-actions';

    // 取消按钮
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'edit-cancel-btn';
    cancelBtn.textContent = '取消';
    cancelBtn.onclick = () => exitEditMode(messageDiv, editContainer);

    // 更新按钮
    const updateBtn = document.createElement('button');
    updateBtn.className = 'edit-update-btn';
    updateBtn.textContent = '更新';
    updateBtn.onclick = () => updateMessage(messageDiv, editContainer, editTextarea.value, messageIndex);

    editActions.appendChild(cancelBtn);
    editActions.appendChild(updateBtn);

    editContainer.appendChild(editTextarea);
    editContainer.appendChild(editActions);

    // 在 avatar 后面插入编辑容器
    const avatar = messageDiv.querySelector('.avatar');
    avatar.after(editContainer);

    // 聚焦输入框
    editTextarea.focus();
    editTextarea.setSelectionRange(editTextarea.value.length, editTextarea.value.length);

    // 支持 Enter 键更新
    editTextarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            updateMessage(messageDiv, editContainer, editTextarea.value, messageIndex);
        }
        if (e.key === 'Escape') {
            exitEditMode(messageDiv, editContainer);
        }
    });

    // 自动调整高度
    editTextarea.addEventListener('input', function () {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
    });
}

// 退出编辑模式
function exitEditMode(messageDiv, editContainer) {
    const contentDiv = messageDiv.querySelector('.message-content');
    const actionsDiv = messageDiv.querySelector('.user-message-actions');

    editContainer.remove();
    contentDiv.style.display = '';
    if (actionsDiv) actionsDiv.style.display = '';
}

// 更新消息并重新生成
async function updateMessage(messageDiv, editContainer, newText, messageIndex) {
    if (!newText.trim()) return;

    // 找到该消息在 messageHistory 中的索引
    const allMessages = chatContainer.querySelectorAll('.message');
    let actualIndex = messageIndex;

    if (actualIndex === -1) {
        // 如果没有提供索引，尝试查找
        actualIndex = Array.from(allMessages).indexOf(messageDiv);
    }

    // 计算对应的 messageHistory 索引（DOM 和 history 是1:1对应的）
    const historyIndex = actualIndex;

    if (historyIndex < 0 || historyIndex >= messageHistory.length) {
        exitEditMode(messageDiv, editContainer);
        return;
    }

    // 构建新的消息内容
    const originalContent = messageHistory[historyIndex].content;
    let newContent;

    if (Array.isArray(originalContent)) {
        // 如果原消息包含图片，保留图片，只更新文本
        newContent = originalContent.map(item => {
            if (item.type === 'text') {
                return { type: 'text', text: newText };
            }
            return item;
        });
        // 如果原消息没有文本项但有新文本，添加一个
        if (!originalContent.some(item => item.type === 'text') && newText) {
            newContent.unshift({ type: 'text', text: newText });
        }
    } else {
        newContent = [{ type: 'text', text: newText }];
    }

    // 更新 messageHistory 和 DOM 元素上存储的原始内容
    messageHistory[historyIndex].content = newContent;
    messageDiv._originalContent = newContent;

    // 删除该消息之后的所有消息（从 DOM 和 history）
    messageHistory = messageHistory.slice(0, historyIndex + 1);

    // 从 DOM 中删除后续消息
    const messagesToRemove = Array.from(allMessages).slice(actualIndex + 1);
    messagesToRemove.forEach(msg => msg.remove());

    // 更新当前消息的显示
    exitEditMode(messageDiv, editContainer);
    const contentDiv = messageDiv.querySelector('.message-content');
    contentDiv.innerHTML = '';

    if (Array.isArray(newContent)) {
        newContent.forEach(item => {
            if (item.type === 'image_url') {
                renderThumbnail(contentDiv, item.image_url.url);
            } else if (item.type === 'text') {
                const textDiv = document.createElement('div');
                renderMarkdownWithMath(item.text, textDiv);
                contentDiv.appendChild(textDiv);
            }
        });
    } else {
        renderMarkdownWithMath(newContent, contentDiv);
    }

    // 保存更新后的对话
    let conv = conversations.find(c => c.id === currentConversationId);
    if (conv) {
        conv.messages = [...messageHistory];
        conv.timestamp = Date.now();
        saveHistory();
    }

    // 重新生成 AI 回复
    const model = modelSelect.value;
    updateSendButtonState(true);

    if (model === 'gemini-3-pro-image-preview') {
        const recentMessages = messageHistory.slice(-20);
        await generateImage(recentMessages, model);
    } else {
        await generateText(newContent, model);
    }
}

async function regenerateLastMessage() {
    if (messageHistory.length === 0) return;
    if (isGenerating) return; // 如果正在生成，不允许重新生成

    const lastMsg = messageHistory[messageHistory.length - 1];
    let lastUserMsgText = "";

    if (lastMsg.role === 'assistant') {
        messageHistory.pop();
        chatContainer.lastChild.remove();

        const lastUserMsg = messageHistory[messageHistory.length - 1];
        if (lastUserMsg && lastUserMsg.role === 'user') {
            lastUserMsgText = lastUserMsg.content;
        }
    } else {
        lastUserMsgText = lastMsg.content;
    }

    if (!lastUserMsgText) return;

    const model = modelSelect.value;

    // 更新按钮为停止状态
    updateSendButtonState(true);

    // 更新对话状态（移除被撤销的消息）
    updateCurrentConversation('assistant', '', false);
    let conv = conversations.find(c => c.id === currentConversationId);
    if (conv) {
        conv.messages = [...messageHistory];
        saveHistory();
    }

    await generateText(lastUserMsgText, model);
    // 按钮状态会在 generateText 的 finally 中恢复
}

async function handleSend() {
    const text = userInput.value.trim();
    if (!text && selectedImages.length === 0) return;

    const welcomeMsg = chatContainer.querySelector('.welcome-message');
    if (welcomeMsg) welcomeMsg.remove();

    userInput.value = '';
    userInput.style.height = 'auto';

    let messageContent = [];
    const tempImageUrls = []; // 用于本地预览

    // 1. 上传图片 (如果有)
    if (selectedImages.length > 0) {
        // 显示一个临时的 loading 指示 (可选)
        const { messageDiv: loadingMsgDiv } = appendMessage('user', "📤 Uploading images...");

        try {
            // 并行上传
            const uploadPromises = selectedImages.map(file => uploadFile(file));
            const serverUrls = await Promise.all(uploadPromises);

            // 构建消息内容
            if (text) messageContent.push({ type: "text", text: text });

            serverUrls.forEach(url => {
                messageContent.push({
                    type: "image_url",
                    image_url: { url: url } // 这里存的是 /images/cache/xxx.jpg
                });
                tempImageUrls.push(url);
            });

            // 移除 Loading
            loadingMsgDiv.remove();

        } catch (e) {
            console.error("Upload failed", e);
            if (loadingMsgDiv) loadingMsgDiv.remove();
            alert("Failed to upload images: " + e.message);
            return;
        }
    } else {
        // 纯文本处理
        messageContent = text; // 保持字符串以兼容旧逻辑，或者统一成数组
        // 为了统一，建议后端处理好，或者这里：
        if (text) messageContent = [{ type: "text", text: text }];
    }

    // 显示用户消息
    // 注意：如果是数组，appendMessage 会自动处理并添加到 currentSessionImages
    // 传递当前 messageHistory 的长度作为索引（因为消息将在下面被 push）
    const currentMsgIndex = messageHistory.length;
    const { messageDiv: userMessageDiv } = appendMessage('user', messageContent, false, currentMsgIndex);

    // 发送消息后，将用户消息滚动到页面顶部
    setTimeout(() => {
        userMessageDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);

    // 存入历史
    messageHistory.push({ role: "user", content: messageContent });
    updateCurrentConversation('user', messageContent);

    selectedImages = [];
    renderImagePreviews();

    const model = modelSelect.value;

    // 更新按钮为停止状态
    updateSendButtonState(true);

    if (model === 'gemini-3-pro-image-preview') {
        const recentMessages = messageHistory.slice(-20);

        await generateImage(recentMessages, model);
    } else {
        await generateText(messageContent, model);
    }

    // 按钮状态会在 generateText/generateImage 的 finally 中恢复
}

async function generateImage(messages, model = "gemini-3-pro-image-preview") {
    // 创建 AbortController
    currentAbortController = new AbortController();
    isGenerating = true;

    const { messageDiv: loadingMsgDiv, contentDiv: loadingContentDiv } = appendMessage('ai', 'Generating image with Gemini 3...');
    const toolbar = loadingContentDiv.querySelector('.message-toolbar');
    if (toolbar) toolbar.remove();

    try {
        const res = await fetch('/api/images/generations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: model,
                messages: messages // 直接发送整个历史
            }),
            signal: currentAbortController.signal
        });

        const data = await res.json();

        if (loadingMsgDiv) {
            loadingMsgDiv.remove();
        }

        if (data.error) {
            const msg = (data.error && data.error.message) ? data.error.message : (data.error || "Unknown error");
            appendMessage('ai', `Error: ${msg}`);
        } else {
            const resultUrl = data.data[0].url;
            const thoughtSignature = data.data[0].thoughtSignature;

            appendMessage('ai', resultUrl, true);

            const historyContent = [{
                type: "image_url",
                image_url: {
                    url: resultUrl
                },
                thoughtSignature: thoughtSignature
            }];
            messageHistory.push({ role: "assistant", content: historyContent, isImage: true });
            updateCurrentConversation('assistant', historyContent, true);
        }
    } catch (e) {
        if (e.name === 'AbortError') {
            console.log('Image generation request was aborted');
            // 请求被取消，静默处理
        } else {
            if (loadingMsgDiv) {
                loadingMsgDiv.remove();
            }
            appendMessage('ai', "Failed to generate image.");
            console.error(e);
        }
    } finally {
        isGenerating = false;
        currentAbortController = null;
        updateSendButtonState(false);
    }
}

async function generateText(prompt, model) {
    // 创建 AbortController
    currentAbortController = new AbortController();
    isGenerating = true;
    currentFullResponse = ''; // 重置全局响应内容

    const { contentDiv: aiContentDiv } = appendMessage('ai', 'AI思考中...');
    currentAiContentDiv = aiContentDiv; // 保存到全局变量
    // 移除加载中的重试按钮
    const loadingToolbar = aiContentDiv.querySelector('.message-toolbar');
    if (loadingToolbar) loadingToolbar.remove();

    let fullResponse = "";

    try {
        const res = await fetch('/api/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: model,
                messages: messageHistory,
                stream: true
            }),
            signal: currentAbortController.signal
        });

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || `HTTP error! status: ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");

        aiContentDiv.innerHTML = "";

        let buffer = "";
        while (true) {
            // 检查是否被取消
            if (currentAbortController && currentAbortController.signal.aborted) {
                reader.cancel();
                break;
            }

            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const dataStr = line.slice(6);
                    if (dataStr === '[DONE]') break;

                    try {
                        const data = JSON.parse(dataStr);
                        const delta = data.choices[0].delta || {};

                        if (delta.content) {
                            const content = delta.content || "";

                            fullResponse += content;
                            currentFullResponse = fullResponse; // 同步到全局变量

                            // 流式更新时使用轻量级渲染
                            renderMarkdownStreaming(fullResponse, aiContentDiv);

                            // 不再自动滚动，让用户完全用鼠标自主控制浏览位置
                        }
                    } catch (e) { }
                }
            }
        }

        // 只有在未被取消时才保存和显示结果
        if (!currentAbortController || !currentAbortController.signal.aborted) {
            // 流式传输结束，完成最终渲染（包含数学公式）
            finalizeMarkdownRender(aiContentDiv);

            // 添加 Retry 按钮
            appendRetryButton(aiContentDiv);

            messageHistory.push({ role: "assistant", content: fullResponse });
            updateCurrentConversation('assistant', fullResponse);
        }

    } catch (e) {
        if (e.name === 'AbortError') {
            console.log('Chat request was aborted');
            // 请求被取消，静默处理
        } else {
            aiContentDiv.innerHTML = `<span class="error-text">⚠️ Error: ${e.message}</span>`;
            appendRetryButton(aiContentDiv); // 出错也给重试机会
        }
    } finally {
        isGenerating = false;
        currentAbortController = null;
        currentAiContentDiv = null;
        currentFullResponse = '';
        updateSendButtonState(false);
    }
}

// Event Listeners
sendBtn.addEventListener('click', () => {
    if (isGenerating) {
        // 如果正在生成，点击按钮执行停止操作
        stopGeneration(true);
    } else {
        // 否则执行发送操作
        handleSend();
    }
});
userInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!isGenerating) {
            handleSend();
        }
    }
});

userInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
});

sidebarNewChatBtn.addEventListener('click', () => {
    startNewChat();
    if (window.innerWidth <= 768) {
        closeSidebar();
    }
});

// 模型切换监听：切换到/从生图模型时自动开启新对话
let previousModel = modelSelect.value;
modelSelect.addEventListener('change', () => {
    const newModel = modelSelect.value;
    const imageModel = 'gemini-3-pro-image-preview';

    // 如果切换到生图模型或从生图模型切出，自动开启新对话
    if (newModel === imageModel || previousModel === imageModel) {
        startNewChat();
    }

    previousModel = newModel;
});

document.addEventListener('keydown', (e) => {
    if (!lightbox.classList.contains('active')) return;

    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') changeLightboxImage(-1);
    if (e.key === 'ArrowRight') changeLightboxImage(1);
    // 也可以支持上下键
    if (e.key === 'ArrowUp') changeLightboxImage(-1);
    if (e.key === 'ArrowDown') changeLightboxImage(1);
});

// === History Search Feature ===
const searchHistoryBtn = document.getElementById('search-history-btn');
const searchPanel = document.getElementById('search-panel');
const searchInput = document.getElementById('search-input');
const clearSearchBtn = document.getElementById('clear-search-btn');
const searchResults = document.getElementById('search-results');

let searchDebounceTimer = null;

// Toggle search panel
searchHistoryBtn.addEventListener('click', () => {
    searchPanel.classList.toggle('hidden');
    if (!searchPanel.classList.contains('hidden')) {
        searchInput.focus();
    } else {
        // 关闭时清空
        searchInput.value = '';
        searchResults.innerHTML = '';
        clearSearchBtn.classList.add('hidden');
    }
});

// Search input handling
searchInput.addEventListener('input', (e) => {
    const query = e.target.value.trim();

    // Show/hide clear button
    if (query) {
        clearSearchBtn.classList.remove('hidden');
    } else {
        clearSearchBtn.classList.add('hidden');
    }

    // Debounce search
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
        performSearch(query);
    }, 200);
});

// Clear search
clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    searchResults.innerHTML = '';
    clearSearchBtn.classList.add('hidden');
    searchInput.focus();
});

// Close search on Escape
searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        searchPanel.classList.add('hidden');
        searchInput.value = '';
        searchResults.innerHTML = '';
        clearSearchBtn.classList.add('hidden');
    }
});

// Perform the search
function performSearch(query) {
    searchResults.innerHTML = '';

    if (!query) return;

    const lowerQuery = query.toLowerCase();
    const results = [];

    conversations.forEach(conv => {
        // Search in conversation title
        const titleMatch = conv.title?.toLowerCase().includes(lowerQuery);

        // Search in messages
        let matchedMessage = null;
        let matchContext = '';

        for (const msg of conv.messages || []) {
            const textContent = extractMessageText(msg);
            if (textContent.toLowerCase().includes(lowerQuery)) {
                matchedMessage = msg;
                matchContext = getMatchContext(textContent, lowerQuery);
                break;
            }
        }

        if (titleMatch || matchedMessage) {
            results.push({
                conversation: conv,
                matchContext: matchContext || (titleMatch ? 'Title match' : ''),
                query: query
            });
        }
    });

    // Render results
    if (results.length === 0) {
        searchResults.innerHTML = '<div class="search-no-results">No results found</div>';
        return;
    }

    results.forEach(result => {
        const item = document.createElement('div');
        item.className = 'search-result-item';

        const title = document.createElement('div');
        title.className = 'search-result-title';
        title.textContent = result.conversation.title || 'New Chat';

        const match = document.createElement('div');
        match.className = 'search-result-match';
        match.innerHTML = highlightMatch(result.matchContext, result.query);

        item.appendChild(title);
        item.appendChild(match);

        item.addEventListener('click', () => {
            loadConversation(result.conversation.id);
            searchPanel.classList.add('hidden');
            searchInput.value = '';
            searchResults.innerHTML = '';
            clearSearchBtn.classList.add('hidden');

            // Mobile: close sidebar
            if (window.innerWidth <= 768) {
                closeSidebar();
            }
        });

        searchResults.appendChild(item);
    });
}

// Extract text from message content
function extractMessageText(msg) {
    const content = msg.content;

    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .filter(item => item.type === 'text')
            .map(item => item.text)
            .join(' ');
    }

    return '';
}

// Get context around the match
function getMatchContext(text, query) {
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const index = lowerText.indexOf(lowerQuery);

    if (index === -1) return text.substring(0, 60) + '...';

    // Get surrounding context
    const contextStart = Math.max(0, index - 20);
    const contextEnd = Math.min(text.length, index + query.length + 40);

    let context = text.substring(contextStart, contextEnd);

    if (contextStart > 0) context = '...' + context;
    if (contextEnd < text.length) context = context + '...';

    return context;
}

// Highlight matching text in the context
function highlightMatch(text, query) {
    if (!query) return escapeHtml(text);

    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escapedQuery})`, 'gi');

    return escapeHtml(text).replace(regex, '<span class="highlight">$1</span>');
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
