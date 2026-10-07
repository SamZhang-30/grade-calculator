import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
    plugins: [react()],
    // Relative assets work on both a user site and a project site.
    base: "./",
});
