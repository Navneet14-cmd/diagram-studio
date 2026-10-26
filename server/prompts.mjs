// Prompts are kept short and concrete for small local models:
// rules first (system), then one few-shot pair, then the real request as the last message.

export const DIAGRAM_TYPES = ["flowchart", "sequence", "er", "architecture"];

const CHEAT_SHEET = `Mermaid rules:
1. Output Mermaid code only. No markdown fences, no explanations, no comments.
2. Exactly one diagram. The first line is the diagram keyword.
3. Put double quotes around every label that has spaces or punctuation: A["Log in (SSO)"], A -->|"no"| B.
4. Node IDs are short words with letters, digits or underscores. Never use end as a node ID.
5. Keep it under 15 nodes unless the user asks for more.
Syntax:
- flowchart TD / flowchart LR. Edge A --> B. Labeled edge A -->|"yes"| B. Decision C{"Valid?"}. Database D[("DB")].
- subgraph id["Title"] ... end groups nodes.
- sequenceDiagram: participant U as User, messages U->>A: text, replies A-->>U: text, alt/else/end blocks. No quotes in messages.
- erDiagram: CUSTOMER ||--o{ ORDER : places. Entity block: ORDER { int id PK  string status }. Types are single words.`;

const EXAMPLES = {
  flowchart: {
    request: "Password reset flow",
    code: `flowchart TD
  start(["Start"]) --> form["Enter email"]
  form --> check{"Account exists?"}
  check -->|"yes"| mail["Send reset link"]
  check -->|"no"| err["Show error"]
  err --> form
  mail --> done(["Done"])`,
  },
  sequence: {
    request: "Sequence diagram of a user loading their profile",
    code: `sequenceDiagram
  participant U as User
  participant W as Web App
  participant API as API
  U->>W: Open profile page
  W->>API: GET /profile
  API-->>W: Profile JSON
  W-->>U: Render profile`,
  },
  er: {
    request: "ER diagram for a library",
    code: `erDiagram
  MEMBER ||--o{ LOAN : borrows
  BOOK ||--o{ LOAN : "is lent in"
  MEMBER {
    int id PK
    string name
  }
  BOOK {
    int id PK
    string title
  }
  LOAN {
    int id PK
    int member_id FK
    int book_id FK
    date due
  }`,
  },
  architecture: {
    request: "Architecture of a blog platform",
    code: `flowchart LR
  user["Reader"] --> cdn["CDN"]
  cdn --> web["Web Server"]
  subgraph backend["Backend"]
    web --> api["Posts API"]
    api --> cache[("Cache")]
    api --> db[("SQL Database")]
  end`,
  },
};

const HEADERS = { flowchart: "flowchart TD", sequence: "sequenceDiagram", er: "erDiagram", architecture: "flowchart LR" };

/** Cheap keyword guess; also the fallback when the model's JSON is unusable. */
export function guessDiagramType(prompt) {
  const p = prompt.toLowerCase();
  if (/\bsequence\b|\binteraction\b|\bhandshake\b|\bcalls? between\b/.test(p)) return "sequence";
  if (/\b(er|erd|entity|entities|schema|database model|data model|tables?)\b/.test(p)) return "er";
  if (/\barchitecture\b|\bmicroservices?\b|\binfrastructure\b|\bsystem design\b|\bdeployment\b|\bcloud\b/.test(p)) return "architecture";
  return null;
}

export function analyzeMessages(prompt) {
  return [
    {
      role: "system",
      content: `You classify diagram requests. Reply with JSON only:
{"needsClarification": false, "diagramType": "flowchart", "questions": []}
diagramType is one of: flowchart, sequence, er, architecture. Prefer flowchart when unsure.
Set needsClarification to true ONLY if the request is so vague that no sensible diagram can be drawn (for example "a diagram" or "my app").
Most requests are clear enough: then needsClarification is false and questions is [].
If true, add at most 3 questions as {"question": "...", "options": ["...", "..."]} with 2-4 short options.`,
    },
    { role: "user", content: "Request: checkout flow for an online store" },
    { role: "assistant", content: '{"needsClarification": false, "diagramType": "flowchart", "questions": []}' },
    { role: "user", content: `Request: ${prompt}` },
  ];
}

function requestText(prompt, answers) {
  const extra = (answers ?? []).filter((a) => a?.question && a?.answer).map((a) => `- ${a.question} ${a.answer}`);
  return extra.length ? `${prompt}\nDetails:\n${extra.join("\n")}` : prompt;
}

export function generateMessages(prompt, diagramType, answers) {
  const type = DIAGRAM_TYPES.includes(diagramType) ? diagramType : "flowchart";
  const ex = EXAMPLES[type];
  return [
    { role: "system", content: `You turn requests into Mermaid diagrams.\n${CHEAT_SHEET}\nUse this diagram type: ${HEADERS[type]}.` },
    { role: "user", content: ex.request },
    { role: "assistant", content: ex.code },
    { role: "user", content: requestText(prompt, answers) },
  ];
}

export function editMessages(code, instruction) {
  return [
    {
      role: "system",
      content: `You edit Mermaid diagrams.\n${CHEAT_SHEET}\nApply the requested change and return the COMPLETE updated diagram, every line, not a patch or a diff. Keep everything the change does not touch.`,
    },
    { role: "user", content: `Current diagram:\n${EXAMPLES.flowchart.code}\n\nChange: add a step that logs the reset request after sending the link` },
    {
      role: "assistant",
      content: EXAMPLES.flowchart.code.replace('mail --> done(["Done"])', 'mail --> log["Log reset request"]\n  log --> done(["Done"])'),
    },
    { role: "user", content: `Current diagram:\n${code}\n\nChange: ${instruction}` },
  ];
}

function numbered(code) {
  return code.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n");
}

/** Mermaid reports where it noticed the problem; the cause is often the line before (an unclosed bracket). */
export function suspectLines(code, error) {
  const lines = code.split("\n");
  const n = Number(String(error).match(/line (\d+)/i)?.[1]);
  if (!n) return "";
  return [n - 1, n].filter((k) => k >= 2 && k <= lines.length).map((k) => `${k}: ${lines[k - 1]}`).join("\n");
}

export function repairMessages(code, error) {
  const suspects = suspectLines(code, error);
  return [
    {
      role: "system",
      content: `You fix Mermaid syntax errors.\n${CHEAT_SHEET}\nCheck every bracket is closed: [ ], ( ), { }, {{ }}, [( )]. Only use arrows valid for the diagram type (flowchart: -->, ---, -.->, ==>).
Return the complete corrected diagram WITHOUT line numbers. Keep the same nodes and meaning; only fix the syntax. Never return the code unchanged.`,
    },
    {
      role: "user",
      content: `Code:\n1: flowchart TD\n2:   a[Start (now) --> b\n3:   b --> end\n\nParser error:\nParse error on line 3: Expecting 'SQE', got 'PS'\n\nLook closely at these lines:\n2:   a[Start (now) --> b\n3:   b --> end`,
    },
    { role: "assistant", content: `flowchart TD\n  a["Start (now)"] --> b\n  b --> end_["End"]` },
    {
      role: "user",
      content: `Code:\n${numbered(code)}\n\nParser error:\n${error}${suspects ? `\n\nLook closely at these lines:\n${suspects}` : ""}`,
    },
  ];
}

export function suggestMessages(code) {
  return [
    {
      role: "system",
      content: `You suggest improvements to a Mermaid diagram. Reply with JSON only, in the form
{"suggestions": [{"label": "...", "instruction": "..."}]}
Give exactly 3 suggestions. "label" is a 2-4 word button label naming the change. "instruction" is one sentence telling an editor what to change.
Each edit must mention real parts of THIS diagram and be small enough to apply in one step.`,
    },
    { role: "user", content: `Diagram:\n${EXAMPLES.flowchart.code}` },
    {
      role: "assistant",
      content: JSON.stringify({ suggestions: [
        { label: "Add rate limiting", instruction: "Add a step after Send reset link that blocks more than 3 reset requests per hour." },
        { label: "Expire reset links", instruction: "Add a check that the reset link is less than 30 minutes old before allowing a new password." },
        { label: "Confirm by email", instruction: "Add a final step that emails the user to confirm the password was changed." },
      ] }),
    },
    { role: "user", content: `Diagram:\n${code}` },
  ];
}
