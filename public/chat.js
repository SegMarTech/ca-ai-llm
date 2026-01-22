/**
 * Cloudflare Workers AI Chat UI
 */

const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");

let chatHistory = [];
let isProcessing = false;

userInput.addEventListener("keydown", e => {
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

  addMessage("user", message);
  chatHistory.push({ role: "user", content: message });

  userInput.value = "";
  typingIndicator.classList.add("visible");

  const assistantEl = addMessage("assistant", "");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: message,
        messages: chatHistory,
      }),
    });

    const text = await res.text(); // 🔑 read full body once

    let output = text;

    // ✅ Handle JSON response
    try {
      const parsed = JSON.parse(text);
      if (parsed.answer) {
        output = parsed.answer;
      }
    } catch (_) {
      // Not JSON → treat as plain text
    }

    assistantEl.textContent = output;
    chatHistory.push({ role: "assistant", content: output });
  } catch (err) {
    assistantEl.textContent =
      "Sorry, something went wrong while processing your request.";
    console.error(err);
  } finally {
    typingIndicator.classList.remove("visible");
    isProcessing = false;
    userInput.disabled = false;
    sendButton.disabled = false;
    userInput.focus();
  }
}

function addMessage(role, content) {
  const div = document.createElement("div");
  div.className = `message ${role}-message`;
  const p = document.createElement("p");
  p.textContent = content;
  div.appendChild(p);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return p;
}
