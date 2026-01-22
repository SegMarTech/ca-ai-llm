/**
 * Chat UI – SSE compatible with Worker
 */

const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");

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
      body: JSON.stringify({ query }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalText = "";

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

        if (payload === "[DONE]") return;

        const parsed = JSON.parse(payload);

        if (parsed.token) {
          finalText += parsed.token;
          assistantP.textContent = finalText;
          chatMessages.scrollTop = chatMessages.scrollHeight;
        }
      }
    }
  } catch (e) {
    assistantP.textContent = "Error generating response.";
    console.error(e);
  } finally {
    typingIndicator.classList.remove("visible");
    isProcessing = false;
    userInput.disabled = false;
    sendButton.disabled = false;
    userInput.focus();
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
