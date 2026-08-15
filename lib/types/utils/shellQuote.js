/** cmd.exe joins spawn arguments with spaces; quote anything that could split. */
export function shellQuote(args) {
    return args.map(arg => (/[ \t"^&|<>()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg));
}
