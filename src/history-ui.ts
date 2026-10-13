import { createContext, useContext } from "react";

// Refresh field drafts after history restoration without remounting tables,
// scroll viewports, or open settings panels.
export const HistoryRevisionContext = createContext(0);
export const useHistoryRevision = () => useContext(HistoryRevisionContext);
