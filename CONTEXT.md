[English](CONTEXT.md) | [简体中文](CONTEXT.zh.md)

# Excalidraw Desktop

This context describes the local drawing workspace and document-navigation language used by Excalidraw Desktop. It distinguishes persistent items on disk from the drawings currently open in the application.

## Language

### Workspace navigation

**Workspace**:
A user-authorized local directory whose drawings and ordinary directories are available in the application.
_Avoid_: Project, repository, vault

**Workspace Root**:
The top-level directory of a Workspace. It can be mounted or removed from the application, but it is not an ordinary entry that can be renamed or deleted there.
_Avoid_: Root entry, top folder

**Workspace Entry**:
A Drawing or Directory directly represented within a Workspace.
_Avoid_: Node, item, filesystem object

**Drawing**:
A supported Excalidraw file available to the application, whether represented inside a Workspace or opened directly through an approved file choice.
_Avoid_: Document, canvas file

**Directory**:
An ordinary user-managed folder inside a Workspace.
_Avoid_: Workspace, collection

**Protected Directory**:
A hidden or application-managed directory that is excluded from ordinary rename and delete actions.
_Avoid_: System folder, locked folder

### Open drawing lifecycle

**Open Document**:
The unique in-application editing session for a Drawing, including its unsaved and conflict state.
_Avoid_: Open file, tab

**Orphaned Document**:
An Open Document whose original Drawing path is no longer available.
_Avoid_: Deleted tab, missing file

**Active Drawing**:
The Open Document currently presented on the canvas.
_Avoid_: Selected file, focused tab

### Shell navigation

**Workspace Sidebar**:
The application region that presents mounted Workspaces and their entries.
_Avoid_: File manager, explorer panel

**Transient Sidebar**:
A temporarily opened Workspace Sidebar that overlays the canvas and dismisses after the interaction ends.
_Avoid_: Floating sidebar, auto-hide panel

**Pinned Sidebar**:
A Workspace Sidebar that remains in the window layout until the user unpins it.
_Avoid_: Fixed sidebar, permanent sidebar
