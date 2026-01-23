/**
 * CA Sahab AI Assistant - Professional Chat Logic
 */

// Configuration & State
const CONFIG = {
    DISCLAIMER: "\n\n*This is professional guidance only. Verify with latest laws, notifications, and ICAI guidance.*",
    MARKDOWN_OPTIONS: { gfm: true, breaks: true }
};

let isProcessing = false;

// DOM Elements
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const domainSelector = document.getElementById("domain-selector");
const fileInput = document.getElementById("file-input");

// Initialization
document.addEventListener('DOMContentLoaded', () => {
    userInput.focus();
});

// Event Listeners
sendButton.onclick = sendMessage;

userInput.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
};

/**
 * Main Message Sending Function
 */
async function sendMessage() {
    const query = userInput.value.trim();
    const domain = domainSelector?.value;

    if (!query || isProcessing) return;

    // UI Lock
    toggleLoading(true);
    
    // Add User Message
    appendMessage("user", query);
    userInput.value = "";
    userInput.style.height = 'auto'; // Reset textarea height

    // Prepare Assistant Placeholder
    const { messageDiv, textContainer } = createAssistantPlaceholder();
    
    try {
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, domain }),
        });

        if (!response.ok) throw new Error("Connection failed");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let fullText = "";
        let sources = [];

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n\n");
            buffer = lines.pop(); // Keep partial line in buffer

            for (const line of lines) {
                if (!line.startsWith("data:")) continue;
                const data = line.replace("data:", "").trim();
                if (data === "[DONE]") break;

                try {
                    const parsed = JSON.parse(data);
                    if (parsed.token) {
                        fullText += parsed.token;
                        textContainer.innerHTML = marked.parse(fullText, CONFIG.MARKDOWN_OPTIONS);
                        autoScroll();
                    }
                    if (parsed.sources) sources = parsed.sources;
                } catch (e) {
                    console.error("JSON Parse Error", e);
                }
            }
        }

        // Finalize Response
        finalizeAssistantResponse(messageDiv, textContainer, fullText, sources);

    } catch (err) {
        textContainer.innerHTML = `<span style="color: #ef4444;">Sorry, I encountered an error. Please try again later.</span>`;
        console.error(err);
    } finally {
        toggleLoading(false);
    }
}

/**
 * UI Helper: Create the structure for AI response
 */
function createAssistantPlaceholder() {
    const assistantDiv = document.createElement("div");
    assistantDiv.className = "message assistant-message";
    
    assistantDiv.innerHTML = `
        <div class="avatar">AI</div>
        <div class="bubble">
            <div class="assistant-content"></div>
            <div class="assistant-meta"></div>
        </div>
    `;
    
    chatMessages.appendChild(assistantDiv);
    return { 
        messageDiv: assistantDiv, 
        textContainer: assistantDiv.querySelector(".assistant-content") 
    };
}

/**
 * UI Helper: Append User Message
 */
function appendMessage(role, text) {
    const div = document.createElement("div");
    div.className = `message ${role}-message`;
    div.innerHTML = `
        <div class="avatar">${role === 'user' ? 'U' : 'AI'}</div>
        <div class="bubble">${marked.parse(text)}</div>
    `;
    chatMessages.appendChild(div);
    autoScroll();
}

/**
 * Adds Copy button, Sources, and Disclaimer
 */
function finalizeAssistantResponse(container, contentDiv, text, sources) {
    // 1. Add Disclaimer
    if (!text.includes("professional guidance")) {
        text += CONFIG.DISCLAIMER;
        contentDiv.innerHTML = marked.parse(text);
    }

    // 2. Syntax Highlighting
    if (window.Prism) Prism.highlightAllUnder(contentDiv);

    // 3. Add Metadata Row (Copy Button & Sources)
    const metaDiv = container.querySelector(".assistant-meta");
    metaDiv.style.marginTop = "10px";
    metaDiv.style.display = "flex";
    metaDiv.style.gap = "15px";
    metaDiv.style.alignItems = "center";

    // Copy Button
    const copyBtn = document.createElement("button");
    copyBtn.className = "icon-btn";
    copyBtn.innerHTML = `<i data-lucide="copy" style="width:14px"></i> <span style="font-size:12px">Copy</span>`;
    copyBtn.onclick = () => {
        navigator.clipboard.writeText(text);
        copyBtn.innerHTML = `<i data-lucide="check" style="width:14px"></i> <span style="font-size:12px">Copied</span>`;
        setTimeout(() => {
            copyBtn.innerHTML = `<i data-lucide="copy" style="width:14px"></i> <span style="font-size:12px">Copy</span>`;
            lucide.createIcons();
        }, 2000);
        lucide.createIcons();
    };
    metaDiv.appendChild(copyBtn);

    // Sources Toggle
    if (sources && sources.length > 0) {
        const sourceBtn = document.createElement("button");
        sourceBtn.className = "icon-btn";
        sourceBtn.innerHTML = `<i data-lucide="library" style="width:14px"></i> <span style="font-size:12px">Sources (${sources.length})</span>`;
        
        const sourcePanel = document.createElement("div");
        sourcePanel.className = "sources-panel";
        sourcePanel.style.display = "none";
        sourcePanel.style.marginTop = "10px";
        sourcePanel.style.fontSize = "0.8rem";
        sourcePanel.style.padding = "10px";
        sourcePanel.style.background = "#f3f4f6";
        sourcePanel.style.borderRadius = "8px";
        
        sourcePanel.innerHTML = sources.map((s, i) => `
            <div style="margin-bottom:8px; border-bottom:1px solid #e5e7eb; padding-bottom:4px;">
                <strong>${i+1}. ${s.source}</strong><br/>
                <span style="color:#6b7280">${s.text_snippet?.substring(0, 120)}...</span>
            </div>
        `).join("");

        sourceBtn.onclick = () => {
            sourcePanel.style.display = sourcePanel.style.display === "none" ? "block" : "none";
        };

        metaDiv.appendChild(sourceBtn);
        container.querySelector(".bubble").appendChild(sourcePanel);
    }

    lucide.createIcons();
}

/**
 * Utilities
 */
function toggleLoading(active) {
    isProcessing = active;
    userInput.disabled = active;
    sendButton.disabled = active;
    // Show/hide a simple dot-animation or text in your HTML if you prefer
}

function autoScroll() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
}
