/**
 * CA AI Assistant Chat – SSE streaming + Markdown + Sources + Copy
 */

// Load marked dynamically if not already included
if (!window.marked) {
  const script = document.createElement("script");
  script.src =
    "https://cdn.jsdelivr.net/npm/marked/marked.min.js";
  document.head.appendChild(script);
}

// Prism.js for code highlighting
if (!window.Prism) {
  const prismCSS = document.createElement("link");
  prismCSS.rel = "stylesheet";
  prismCSS.href =
    "https://cdnjs.cloudflare.com/ajax/libs/prism/1.30.0/themes/prism.min.css";
  document.head.appendChild(prismCSS);

  const prismScript = document.createElement("script");
  prismScript.src =
    "https://cdnjs.cloudflare.com/ajax/libs/prism/1.30.0/prism.min.js";
  document.head.appendChild(prismScript);
}

const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const domainSelector = document.getElementById("domain-selector");

let isProcessing = false;

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

  isProcessing = true;
  userInput.disabled = true;
  sendButton.disabled = true;

  addMessage("user", query, true);
  userInput.value = "";
  typingIndicator.classList.add("visible");

  // Assistant placeholder
  const assistantDiv = document.createElement("div");
  assistantDiv.className = "message assistant-message";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = "AI";
  const p = document.createElement("div"); // render Markdown here
  p.innerHTML = "";
  assistantDiv.appendChild(avatar);
  assistantDiv.appendChild(p);
  chatMessages.appendChild(assistantDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, domain }),
    });

    if (!res.ok || !res.body) {
      throw new Error("Invalid response from server");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalText = "";
    let sources = [];

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

        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch (e) {
          console.error("Invalid JSON:", payload);
          continue;
        }

        // Streaming token updates
        if (parsed.token) {
          finalText += parsed.token;
          p.innerHTML = marked.parse(finalText);
          Prism.highlightAll();
          chatMessages.scrollTop = chatMessages.scrollHeight;
        }

        // Capture sources
        if (parsed.sources) {
          sources = parsed.sources;
        }
      }
    }

    // Append disclaimer if missing
    if (
      !finalText.includes(
        "This is professional guidance only. Verify with latest laws, notifications, and ICAI guidance."
      )
    ) {
      finalText +=
        "\n\nThis is professional guidance only. Verify with latest laws, notifications, and ICAI guidance.";
      p.innerHTML = marked.parse(finalText);
      Prism.highlightAll();
    }

    // Copy button
    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy Answer";
    copyBtn.className = "copy-btn";
    copyBtn.onclick = () => navigator.clipboard.writeText(finalText);
    assistantDiv.appendChild(copyBtn);

    // Sources toggle
    if (sources.length) {
      const toggleBtn = document.createElement("span");
      toggleBtn.className = "source-toggle";
      toggleBtn.innerText = "Show / Hide Sources";
      toggleBtn.onclick = () => {
        const el = toggleBtn.nextElementSibling;
        if (el) el.style.display = el.style.display === "block" ? "none" : "block";
      };

      const sourcesDiv = document.createElement("div");
      sourcesDiv.className = "sources";
      sourcesDiv.style.display = "none";
      sourcesDiv.innerHTML = sources
        .map(
          (s, i) =>
            `<div>${i + 1}. <strong>${s.source}</strong>: ${s.text_snippet?.substring(
              0,
              150
            )}...</div>`
        )
        .join("");

      assistantDiv.appendChild(toggleBtn);
      assistantDiv.appendChild(sourcesDiv);
    }
  } catch (err) {
    p.textContent = "Error generating response.";
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

  const p = document.createElement("div");
  p.innerHTML = useMarkdown ? marked.parse(text) : text;

  div.appendChild(avatar);
  div.appendChild(p);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  return p;
}
