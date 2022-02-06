import minimatch from 'minimatch'
import path from 'path'
import { Disposable, Emitter, Event } from 'vscode-languageserver-protocol'
import { URI } from 'vscode-uri'
import { OutputChannel } from '../types'
import { disposeAll } from '../util'
import { splitArray } from '../util/array'
import Watchman, { FileChange } from './watchman'
import WorkspaceFolder from './workspaceFolder'
const logger = require('../util/logger')('filesystem-watcher')

export interface RenameEvent {
  oldUri: URI
  newUri: URI
}

export class FileSystemWatcherManager {
  private creatingRoots: Set<string> = new Set()
  private clientsMap: Map<string, Watchman | null> = new Map()
  private disposables: Disposable[] = []
  private channel: OutputChannel | undefined
  private _disposed = false
  public static watchers: Set<FileSystemWatcher> = new Set()
  private readonly _onDidCreateClient = new Emitter<string>()
  public readonly onDidCreateClient: Event<string> = this._onDidCreateClient.event
  constructor(
    private workspaceFolder: WorkspaceFolder,
    private watchmanPath: string | null
  ) {
  }

  public attach(channel: OutputChannel): void {
    this.channel = channel
    this.workspaceFolder.workspaceFolders.forEach(folder => {
      let root = URI.parse(folder.uri).fsPath
      void this.createClient(root)
    })
    this.workspaceFolder.onDidChangeWorkspaceFolders(e => {
      e.added.forEach(folder => {
        let root = URI.parse(folder.uri).fsPath
        void this.createClient(root)
      })
      e.removed.forEach(folder => {
        let root = URI.parse(folder.uri).fsPath
        let client = this.clientsMap.get(root)
        if (client) client.dispose()
      })
    }, null, this.disposables)
  }

  public waitClient(root: string): Promise<void> {
    if (this.clientsMap.has(root)) return Promise.resolve()
    return new Promise(resolve => {
      let disposable = this.onDidCreateClient(r => {
        if (r == root) {
          disposable.dispose()
          resolve()
        }
      })
    })
  }

  private async createClient(root: string): Promise<void> {
    if (this.watchmanPath == null) return
    if (this.creatingRoots.has(root) || this.clientsMap.has(root)) return
    try {
      this.creatingRoots.add(root)
      let client = await Watchman.createClient(this.watchmanPath, root, this.channel)
      this.creatingRoots.delete(root)
      if (this._disposed) {
        client.dispose()
        return
      }
      this.clientsMap.set(root, client)
      if (client) {
        for (let watcher of FileSystemWatcherManager.watchers) {
          watcher.listen(client)
        }
      }
      this._onDidCreateClient.fire(root)
    } catch (e) {
      logger.error(e)
      if (this.channel) this.channel.appendLine(`Error on create watchman client:` + e.message)
    }
  }

  public createFileSystemWatcher(
    globPattern: string,
    ignoreCreateEvents: boolean,
    ignoreChangeEvents: boolean,
    ignoreDeleteEvents: boolean): FileSystemWatcher {
    let fileWatcher = new FileSystemWatcher(globPattern, ignoreCreateEvents, ignoreChangeEvents, ignoreDeleteEvents)
    for (let client of this.clientsMap.values()) {
      if (client) fileWatcher.listen(client)
    }
    FileSystemWatcherManager.watchers.add(fileWatcher)
    return fileWatcher
  }

  public dispose(): void {
    this._disposed = true
    this.creatingRoots.clear()
    this._onDidCreateClient.dispose()
    for (let client of this.clientsMap.values()) {
      if (client) client.dispose()
    }
    disposeAll(this.disposables)
  }
}

/*
 * FileSystemWatcher for watch workspace folders.
 */
export class FileSystemWatcher implements Disposable {
  private _onDidCreate = new Emitter<URI>()
  private _onDidChange = new Emitter<URI>()
  private _onDidDelete = new Emitter<URI>()
  private _onDidRename = new Emitter<RenameEvent>()
  private disposables: Disposable[] = []
  private _disposed = false
  public subscribe: string
  public readonly onDidCreate: Event<URI> = this._onDidCreate.event
  public readonly onDidChange: Event<URI> = this._onDidChange.event
  public readonly onDidDelete: Event<URI> = this._onDidDelete.event
  public readonly onDidRename: Event<RenameEvent> = this._onDidRename.event

  constructor(
    private globPattern: string,
    public ignoreCreateEvents: boolean,
    public ignoreChangeEvents: boolean,
    public ignoreDeleteEvents: boolean,
  ) {
  }

  public listen(client: Watchman): void {
    let { globPattern,
      ignoreCreateEvents,
      ignoreChangeEvents,
      ignoreDeleteEvents } = this
    const onChange = (change: FileChange) => {
      let { root, files } = change
      files = files.filter(f => f.type == 'f' && minimatch(f.name, globPattern, { dot: true }))
      for (let file of files) {
        let uri = URI.file(path.join(root, file.name))
        if (!file.exists) {
          if (!ignoreDeleteEvents) this._onDidDelete.fire(uri)
        } else {
          if (file.new === true) {
            if (!ignoreCreateEvents) this._onDidCreate.fire(uri)
          } else {
            if (!ignoreChangeEvents) this._onDidChange.fire(uri)
          }
        }
      }
      // file rename
      if (files.length == 2 && !files[0].exists && files[1].exists) {
        let oldFile = files[0]
        let newFile = files[1]
        if (oldFile.size == newFile.size) {
          this._onDidRename.fire({
            oldUri: URI.file(path.join(root, oldFile.name)),
            newUri: URI.file(path.join(root, newFile.name))
          })
        }
      }
      // detect folder rename
      if (files.length >= 2) {
        let [oldFiles, newFiles] = splitArray(files, o => o.exists === false)
        if (oldFiles.length == newFiles.length) {
          for (let oldFile of oldFiles) {
            let newFile = newFiles.find(o => o.size == oldFile.size && o.mtime_ms == oldFile.mtime_ms)
            if (newFile) {
              this._onDidRename.fire({
                oldUri: URI.file(path.join(root, oldFile.name)),
                newUri: URI.file(path.join(root, newFile.name))
              })
            }
          }
        }
      }
    }
    client.subscribe(globPattern, onChange).then(disposable => {
      this.subscribe = disposable.subscribe
      if (this._disposed) return disposable.dispose()
      this.disposables.push(disposable)
    }).logError()
  }

  public dispose(): void {
    this._disposed = true
    FileSystemWatcherManager.watchers.delete(this)
    this._onDidRename.dispose()
    this._onDidCreate.dispose()
    this._onDidChange.dispose()
    disposeAll(this.disposables)
  }
}
