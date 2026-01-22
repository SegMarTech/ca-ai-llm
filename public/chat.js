/**
 * LLM Chat App Frontend – FIXED for Cloudflare Workers AI streaming
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

/* Auto resize */
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
  chatHistory.push({ role: "user", content: message });

  userInput.value = "";
  userInput.style.height = "auto";
  typingIndicator.classList.add("visible");

  const assistantMessageEl = document.createElement("div");
  assistantMessageEl.className = "message assistant-message";
  assistantMessageEl.innerHTML = "<p></p>";
  chatMessages.appendChild(assistantMessageEl);
  const assistantTextEl = assistantMessageEl.querySelector("p");

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: message,
        messages: chatHistory,
      }),
    });

    if (!response.ok || !response.body) {
      throw new Error("Invalid response");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let finalText = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      // 🔑 Workers AI streams RAW text, not SSE
      const chunk = decoder.decode(value, { stream: true });
      finalText += chunk;
      assistantTextEl.textContent = finalText;
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    if (finalText.trim()) {
      chatHistory.push({ role: "assistant", content: finalText });
    }
  } catch (err) {
    console.error(err);
    assistantTextEl.textContent =
      "Sorry, there was an error processing your request.";
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
