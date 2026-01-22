/**
 * LLM Chat App Frontend (FIXED for /api/chat)
 */

const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");

let chatHistory = [
  {
    role: "assistant",
    content:
      "Hello! I'm an LLM chat app powered by Cloudflare Workers AI. How can I help you today?",
  },
];

let isProcessing = false;

/* Auto resize textarea */
userInput.addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = this.scrollHeight + "px";
});

/* Enter to send */
userInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendButton.addEventListener("click", sendMessage);

async function sendMessage() {
  const message = userInput.value.trim();
  if (!message || isProcessing) return;

  isProcessing = true;
  userInput.disabled = true;
  sendButton.disabled = true;

  addMessageToChat("user", message);

  userInput.value = "";
  userInput.style.height = "auto";

  typingIndicator.classList.add("visible");

  chatHistory.push({ role: "user", content: message });

  try {
    const assistantMessageEl = document.createElement("div");
    assistantMessageEl.className = "message assistant-message";
    assistantMessageEl.innerHTML = "<p></p>";
    chatMessages.appendChild(assistantMessageEl);

    const assistantTextEl = assistantMessageEl.querySelector("p");
    chatMessages.scrollTop = chatMessages.scrollHeight;

    /* 🔑 FIX: send BOTH query + messages */
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: message,          // ← REQUIRED by backend
        messages: chatHistory,   // ← for conversation memory
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    if (!response.body) {
      throw new Error("Empty response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let responseText = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const parsed = consumeSseEvents(buffer);
      buffer = parsed.buffer;

      for (const data of parsed.events) {
        if (data === "[DONE]") break;

        try {
          const json = JSON.parse(data);
          const content =
            json.response ||
            json.choices?.[0]?.delta?.content ||
            "";

          if (content) {
            responseText += content;
            assistantTextEl.textContent = responseText;
            chatMessages.scrollTop = chatMessages.scrollHeight;
          }
        } catch {
          /* ignore partial chunks */
        }
      }
    }

    if (responseText) {
      chatHistory.push({ role: "assistant", content: responseText });
    }
  } catch (err) {
    console.error(err);
    addMessageToChat(
      "assistant",
      "Sorry, an error occurred while processing your request."
    );
  } finally {
    typingIndicator.classList.remove("visible");
    isProcessing = false;
    userInput.disabled = false;
    sendButton.disabled = false;
    userInput.focus();
  }
}

function addMessageToChat(role, content) {
  const el = document.createElement("div");
  el.className = `message ${role}-message`;
  el.innerHTML = `<p>${content}</p>`;
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function consumeSseEvents(buffer) {
  buffer = buffer.replace(/\r/g, "");
  const events = [];

  let idx;
  while ((idx = buffer.indexOf("\n\n")) !== -1) {
    const raw = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);

    const dataLines = raw
      .split("\n")
      .filter(l => l.startsWith("data:"))
      .map(l => l.slice(5).trim());

    if (dataLines.length) {
      events.push(dataLines.join("\n"));
    }
  }

  return { events, buffer };
}
