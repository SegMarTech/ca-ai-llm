/**
 * CA Sahab - Professional Chat Logic
 */

// Initialize Marked.js options for security and line breaks
marked.setOptions({
    breaks: true,
    gfm: true
});

const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const domainSelector = document.getElementById("domain-selector");

let isProcessing = false;

// Auto-resize textarea
userInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
});

sendButton.onclick = sendMessage;

userInput.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
};

async function sendMessage() {
    const query = userInput.value.trim();
    const domain = domainSelector?.value;

    if (!query || isProcessing) return;

    // UI State: Loading
    isProcessing = true;
    userInput.disabled = true;
    sendButton.disabled = true;
    userInput.style.height = 'auto';

    // Add User Message
    addMessage("user", query, true);
    userInput.value = "";
    typingIndicator.classList.add("visible");

    // Prepare Assistant Message Placeholder
    const assistantDiv = document.createElement("div");
    assistantDiv.className = "message assistant-message";
    
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = "AI";
    
    const msgBody = document.createElement("div");
    msgBody.className = "msg-body";
    msgBody.innerHTML = "Thinking...";
    
    assistantDiv.appendChild(avatar);
    assistantDiv.appendChild(msgBody);
    chatMessages.appendChild(assistantDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    try {
        const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, domain }),
        });

        if (!res.ok || !res.body) throw new Error("Connection lost");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finalText = "";
        let sources = [];

        msgBody.innerHTML = ""; // Clear "Thinking..."

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            let idx;
            while ((idx = buffer.indexOf("\n\n")) !== -1) {
                const raw = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);

                if (!raw.startsWith("data:")) continue;
                const payload = raw.replace("data:", "").trim();
                if (payload === "[DONE]") break;

                try {
                    const parsed = JSON.parse(payload);
                    if (parsed.token) {
                        finalText += parsed.token;
                        msgBody.innerHTML = marked.parse(finalText);
                        Prism.highlightAll();
                        chatMessages.scrollTop = chatMessages.scrollHeight;
                    }
                    if (parsed.sources) sources = parsed.sources;
                } catch (e) {
                    console.error("JSON Error", e);
                }
            }
        }

        // Finalize: Add Disclaimer & Actions
        const disclaimerTxt = "\n\n---\n*Disclaimer: Verify with latest law & ICAI guidance.*";
        if (!finalText.includes("Disclaimer")) {
            finalText += disclaimerTxt;
            msgBody.innerHTML = marked.parse(finalText);
        }

        // Action Buttons Container
        const actions = document.createElement("div");
        actions.className = "msg-actions";

        // Copy Button
        const copyBtn = document.createElement("button");
        copyBtn.className = "copy-btn";
        copyBtn.innerHTML = "Copy Advice";
        copyBtn.onclick = () => {
            navigator.clipboard.writeText(finalText);
            copyBtn.innerText = "Copied!";
            setTimeout(() => copyBtn.innerText = "Copy Advice", 2000);
        };
        actions.appendChild(copyBtn);

        // Sources
        if (sources && sources.length > 0) {
            const toggle = document.createElement("span");
            toggle.className = "source-toggle";
            toggle.innerText = "View Sources (" + sources.length + ")";
            
            const sourcesDiv = document.createElement("div");
            sourcesDiv.className = "sources";
            sourcesDiv.style.display = "none";
            sourcesDiv.innerHTML = sources.map((s, i) => 
                `<div>${i + 1}. <strong>${s.source}</strong>: ${s.text_snippet?.substring(0, 150)}...</div>`
            ).join("");

            toggle.onclick = () => {
                sourcesDiv.style.display = sourcesDiv.style.display === "none" ? "block" : "none";
            };

            actions.appendChild(toggle);
            actions.appendChild(sourcesDiv);
        }

        msgBody.appendChild(actions);

    } catch (err) {
        msgBody.innerHTML = "⚠️ Error: Unable to fetch response. Please check your connection.";
        console.error(err);
    } finally {
        typingIndicator.classList.remove("visible");
        isProcessing = false;
        userInput.disabled = false;
        sendButton.disabled = false;
        userInput.focus();
    }
}

function addMessage(role, text, useMarkdown = false) {
    const div = document.createElement("div");
    div.className = `message ${role}-message`;

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = role === "user" ? "U" : "AI";

    const body = document.createElement("div");
    body.className = "msg-body";
    body.innerHTML = useMarkdown ? marked.parse(text) : text;

    div.appendChild(avatar);
    div.appendChild(body);
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}
