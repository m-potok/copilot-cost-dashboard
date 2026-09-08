function createExcelBuffer(xlsx, sessions, aicValueEuro) {
  const rows = sessions.map((s) => ({
    Titolo: s.title || "(non disponibile)",
    "ID Sessione": s.sessionId,
    Progetto: s.project || "Non identificato",
    "Percorso Progetto": s.projectPath || "",
    "Data Inizio": new Date(s.startTs || 0).toLocaleString("it-IT"),
    "Model Turns": s.modelTurns || 0,
    "Auto Turns": s.autoDiscountTurns || 0,
    "Tool Calls": s.toolCalls || 0,
    "Input Tokens": s.inputTokens || 0,
    Cached: s.cachedTokens || 0,
    Output: s.outputTokens || 0,
    Total: s.totalTokens || 0,
    Errors: s.errors || 0,
    AIC: Number((s.aic || 0).toFixed(4)),
    "Sconto Auto AIC": Number((s.autoDiscountAmount || 0).toFixed(4)),
    EUR: Number(((s.aic || 0) * aicValueEuro).toFixed(4))
  }));
  const ws = xlsx.utils.json_to_sheet(rows);
  ws["!cols"] = [ { wch: 25 }, { wch: 40 }, { wch: 24 }, { wch: 45 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 12 } ];
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, ws, "Sessioni");
  const projects = new Map();
  for (const s of sessions) {
    const key = s.project || "Non identificato";
    const editing = s.editing || {};
    const current = projects.get(key) || {
      Progetto: key, Sessioni: 0, "Model Turns": 0, "Input Tokens": 0, "Output Tokens": 0,
      AIC: 0, "Costo (EUR)": 0, "File modificati": 0, "Righe aggiunte accettate": 0,
      "Righe rimosse accettate": 0, "Righe aggiunte rifiutate": 0, "Righe rimosse rifiutate": 0,
      "Righe aggiunte manuali": 0, "Righe rimosse manuali": 0, "Righe non classificate": 0
    };
    current.Sessioni += 1;
    current["Model Turns"] += s.modelTurns || 0;
    current["Input Tokens"] += s.inputTokens || 0;
    current["Output Tokens"] += s.outputTokens || 0;
    current.AIC += s.aic || 0;
    current["Costo (EUR)"] += (s.aic || 0) * aicValueEuro;
    current["File modificati"] += editing.files || 0;
    current["Righe aggiunte accettate"] += editing.addedAccepted || 0;
    current["Righe rimosse accettate"] += editing.removedAccepted || 0;
    current["Righe aggiunte rifiutate"] += editing.addedRejected || 0;
    current["Righe rimosse rifiutate"] += editing.removedRejected || 0;
    current["Righe aggiunte manuali"] += editing.addedManual || 0;
    current["Righe rimosse manuali"] += editing.removedManual || 0;
    current["Righe non classificate"] += (editing.addedInferred || 0) + (editing.removedInferred || 0);
    projects.set(key, current);
  }
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet([...projects.values()]), "Progetti");
  return xlsx.write(workbook, { bookType: "xlsx", type: "buffer" });
}

module.exports = { createExcelBuffer };
