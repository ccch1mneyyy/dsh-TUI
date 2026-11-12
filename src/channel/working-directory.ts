/** The directory a session works in now: where it moved after opening (DSH
 *  `working-directory/change`, folded by the projector as `workingDirectory`),
 *  else the project it opened in. Project identity (workspace registry,
 *  session lists, history) stays `cwd`. */
export function sessionWorkingDirectory(session: { readonly cwd: string; readonly workingDirectory: string | undefined }): string {
  return session.workingDirectory ?? session.cwd
}
