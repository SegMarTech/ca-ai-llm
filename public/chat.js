/**
 * Cloudflare Workers AI Chat UI – SSE Streaming
 */

const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");

let chatHistory = [];
let isProcessing = false;

sendButton.onclick = sendMessage;
userInput.onkeydown = e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
};

async function sendMessage() {
  const query = userInput.value.trim();
  if (!query || isProcessing) return;

  isProcessing = true;
  userInput.disabled = true;
  sendButton.disabled = true;

  addMessage("user", query);
  userInput.value = "";
  typingIndicator.classList.add("visible");

  const assistantP = addMessage("assistant", "");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, messages: chatHistory }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";
    let finalAnswer = "";

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

        const parsed = JSON.parse(payload);

        if (parsed.token) {
          finalAnswer += parsed.token;
          assistantP.textContent = finalAnswer;
          chatMessages.scrollTop = chatMessages.scrollHeight;
        }

        if (parsed.done) {
          chatHistory.push({
            role: "assistant",
            content: parsed.answer,
          });
        }
      }
    }
  } catch (err) {
    assistantP.textContent =
      "Error while streaming response. Please try again.";
    console.error(err);
  } finally {
    typingIndicator.classList.remove("visible");
    isProcessing = false;
    userInput.disabled = false;
    sendButton.disabled = false;
  }
}

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = `message ${role}-message`;
  const p = document.createElement("p");
  p.textContent = text;
  div.appendChild(p);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return p;
}
