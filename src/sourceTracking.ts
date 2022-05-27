/*
 * Copyright (c) 2021, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import * as fs from 'fs';
import { resolve, sep, normalize } from 'path';
import { NamedPackageDir, Logger, Org, SfProject, Lifecycle } from '@salesforce/core';
import { AsyncCreatable } from '@salesforce/kit';
import { getString, isString, getBoolean } from '@salesforce/ts-types';
import {
  ComponentSet,
  MetadataResolver,
  ComponentStatus,
  SourceComponent,
  FileResponse,
  ForceIgnore,
  DestructiveChangesType,
  VirtualTreeContainer,
  DeployResult,
  ScopedPreDeploy,
  ScopedPostRetrieve,
  ScopedPreRetrieve,
  ScopedPostDeploy,
  RetrieveResult,
} from '@salesforce/source-deploy-retrieve';
import { RemoteSourceTrackingService, remoteChangeElementToChangeResult } from './shared/remoteSourceTrackingService';
import { ShadowRepo } from './shared/localShadowRepo';
import { throwIfConflicts, findConflictsInComponentSet, dedupeConflictChangeResults } from './shared/conflicts';
import {
  RemoteSyncInput,
  StatusOutputRow,
  ChangeOptions,
  ChangeResult,
  ChangeOptionType,
  LocalUpdateOptions,
  RemoteChangeElement,
} from './shared/types';
import { sourceComponentGuard } from './shared/guards';
import { isBundle, pathIsInFolder, ensureRelative } from './shared/functions';
import { registrySupportsType } from './shared/metadataKeys';
import { hasSfdxTrackingFiles } from './compatibility';
import { populateFilePaths } from './shared/populateFilePaths';
import { populateTypesAndNames } from './shared/populateTypesAndNames';

export interface SourceTrackingOptions {
  org: Org;
  project: SfProject;
  subscribeSDREvents?: boolean;
  ignoreConflicts?: boolean;
}

/**
 * Manages source tracking files (remote and local)
 *
 * const tracking = await SourceTracking.create({org: this.org, project: this.project});
 *
 */
export class SourceTracking extends AsyncCreatable {
  private org: Org;
  private project: SfProject;
  private projectPath: string;
  private packagesDirs: NamedPackageDir[];
  private logger: Logger;
  // remote and local tracking may not exist if not initialized
  private localRepo!: ShadowRepo;
  private remoteSourceTrackingService!: RemoteSourceTrackingService;
  private forceIgnore!: ForceIgnore;
  private hasSfdxTrackingFiles: boolean;
  private ignoreConflicts: boolean;
  private subscribeSDREvents: boolean;
  private orgId: string;

  public constructor(options: SourceTrackingOptions) {
    super(options);
    this.org = options.org;
    this.orgId = this.org.getOrgId();
    this.projectPath = options.project.getPath();
    this.packagesDirs = options.project.getPackageDirectories();
    this.logger = Logger.childFromRoot('SourceTracking');
    this.project = options.project;
    this.ignoreConflicts = options.ignoreConflicts ?? false;
    this.subscribeSDREvents = options.subscribeSDREvents ?? false;
    this.hasSfdxTrackingFiles = hasSfdxTrackingFiles(this.orgId, this.projectPath);
    this.maybeSubscribeLifecycleEvents();
  }

  public async init(): Promise<void> {
    // reserved for future use
  }

  /**
   *
   * @param byPackageDir if true, returns a ComponentSet for each packageDir that has any changes
   * * if false, returns an array containing one ComponentSet with all changes
   * * if not specified, this method will follow what sfdx-project.json says
   * @returns ComponentSet[]
   */
  public async localChangesAsComponentSet(byPackageDir?: boolean): Promise<ComponentSet[]> {
    const [projectConfig] = await Promise.all([this.project.resolveProjectConfig(), this.ensureLocalTracking()]);
    this.forceIgnore ??= ForceIgnore.findAndCreate(this.project.getDefaultPackage().name);

    const sourceApiVersion = getString(projectConfig, 'sourceApiVersion');

    // optimistic resolution...some files may not be possible to resolve
    const resolverForNonDeletes = new MetadataResolver();
    // we need virtual components for the deletes.
    // TODO: could we use the same for the non-deletes?

    const [allNonDeletes, allDeletes] = (
      await Promise.all([this.localRepo.getNonDeleteFilenames(), this.localRepo.getDeleteFilenames()])
    )
      // remove the forceIgnored items early
      .map((group) => group.filter((item) => this.forceIgnore.accepts(item)));

    // it'll be easier to filter filenames and work with smaller component sets than to filter SourceComponents
    const groupings = // if the users specified true or false for the param, that overrides the project config
      (
        byPackageDir ?? getBoolean(projectConfig, 'pushPackageDirectoriesSequentially', false)
          ? this.packagesDirs.map((pkgDir) => ({
              path: pkgDir.name,
              nonDeletes: allNonDeletes.filter((f) => pathIsInFolder(f, pkgDir.name)),
              deletes: allDeletes.filter((f) => pathIsInFolder(f, pkgDir.name)),
            }))
          : [
              {
                nonDeletes: allNonDeletes,
                deletes: allDeletes,
                path: this.packagesDirs.map((dir) => dir.name).join(';'),
              },
            ]
      ).filter((group) => group.deletes.length || group.nonDeletes.length);
    this.logger.debug(`will build array of ${groupings.length} componentSet(s)`);

    return groupings
      .map((grouping) => {
        this.logger.debug(
          `building componentSet for ${grouping.path} (deletes: ${grouping.deletes.length} nonDeletes: ${grouping.nonDeletes.length})`
        );

        const componentSet = new ComponentSet();
        if (sourceApiVersion) {
          componentSet.sourceApiVersion = sourceApiVersion;
        }

        const resolverForDeletes = new MetadataResolver(
          undefined,
          VirtualTreeContainer.fromFilePaths(grouping.deletes)
        );

        grouping.deletes
          .flatMap((filename) => resolverForDeletes.getComponentsFromPath(filename))
          .filter(sourceComponentGuard)
          .map((component) => {
            // if the component is a file in a bundle type AND there are files from the bundle that are not deleted, set the bundle for deploy, not for delete
            if (isBundle(component) && component.content && fs.existsSync(component.content)) {
              // all bundle types have a directory name
              try {
                resolverForNonDeletes
                  .getComponentsFromPath(resolve(component.content))
                  .filter(sourceComponentGuard)
                  .map((nonDeletedComponent) => componentSet.add(nonDeletedComponent));
              } catch (e) {
                this.logger.warn(
                  `unable to find component at ${component.content}.  That's ok if it was supposed to be deleted`
                );
              }
            } else {
              componentSet.add(component, DestructiveChangesType.POST);
            }
          });

        grouping.nonDeletes
          .flatMap((filename) => {
            try {
              return resolverForNonDeletes.getComponentsFromPath(resolve(filename));
            } catch (e) {
              this.logger.warn(`unable to resolve ${filename}`);
              return undefined;
            }
          })
          .filter(sourceComponentGuard)
          .map((component) => componentSet.add(component));

        return componentSet;
      })
      .filter((componentSet) => componentSet.size > 0);
  }

  public async remoteNonDeletesAsComponentSet(): Promise<ComponentSet> {
    const [changeResults, sourceBackedComponents] = await Promise.all([
      // all changes based on remote tracking
      this.getChanges({
        origin: 'remote',
        state: 'nondelete',
        format: 'ChangeResult',
      }),
      // only returns source-backed components (SBC)
      this.getChanges({
        origin: 'remote',
        state: 'nondelete',
        format: 'SourceComponent',
      }),
    ]);
    const componentSet = new ComponentSet(sourceBackedComponents);
    // there may be remote adds not in the SBC.  So we add those manually
    changeResults.forEach((cr) => {
      if (cr.type && cr.name && !componentSet.has({ type: cr.type, fullName: cr.name })) {
        componentSet.add({
          type: cr.type,
          fullName: cr.name,
        });
      }
    });

    return componentSet;
  }
  /**
   * Does most of the work for the force:source:status command.
   * Outputs need a bit of massage since this aims to provide nice json.
   *
   * @param local you want local status
   * @param remote you want remote status
   * @returns StatusOutputRow[]
   */

  public async getStatus({ local, remote }: { local: boolean; remote: boolean }): Promise<StatusOutputRow[]> {
    let results: StatusOutputRow[] = [];
    if (local) {
      results = results.concat(await this.getLocalStatusRows());
    }
    if (remote) {
      await this.ensureRemoteTracking(true);
      const [remoteDeletes, remoteModifies] = await Promise.all([
        this.getChanges({ origin: 'remote', state: 'delete', format: 'ChangeResult' }),
        this.getChanges({ origin: 'remote', state: 'nondelete', format: 'ChangeResultWithPaths' }),
      ]);
      results = results.concat(
        (
          await Promise.all(remoteDeletes.concat(remoteModifies).map((item) => this.remoteChangesToOutputRows(item)))
        ).flat(1)
      );
    }
    if (local && remote) {
      // keys like ApexClass__MyClass.cls
      const conflictFiles = (await this.getConflicts()).flatMap((conflict) => conflict.filenames).filter(isString);
      results = results.map((row) => ({
        ...row,
        conflict: !!row.filePath && conflictFiles.includes(row.filePath),
      }));
    }
    return results;
  }

  /**
   * Get metadata changes made locally and in the org.
   *
   * @returns local and remote changed metadata
   *
   */
  public async getChanges(options: ChangeOptions & { format: 'string' }): Promise<string[]>;
  public async getChanges(options: ChangeOptions & { format: 'SourceComponent' }): Promise<SourceComponent[]>;
  public async getChanges(options: ChangeOptions & { format: 'ChangeResult' }): Promise<ChangeResult[]>;
  public async getChanges(
    options: ChangeOptions & { format: 'ChangeResultWithPaths' }
  ): Promise<Array<ChangeResult & { filename: string[] }>>;
  public async getChanges(options?: ChangeOptions): Promise<ChangeOptionType[]> {
    if (options?.origin === 'local') {
      await this.ensureLocalTracking();
      const filenames: string[] = await this.getLocalChangesAsFilenames(options.state);
      if (options.format === 'string') {
        return filenames;
      }
      if (options.format === 'ChangeResult' || options.format === 'ChangeResultWithPaths') {
        return filenames.map((filename) => ({
          filenames: [filename],
          origin: 'local',
        }));
      }
      if (options.format === 'SourceComponent') {
        const resolver =
          options.state === 'delete'
            ? new MetadataResolver(undefined, VirtualTreeContainer.fromFilePaths(filenames))
            : new MetadataResolver();

        return filenames
          .flatMap((filename) => {
            try {
              return resolver.getComponentsFromPath(filename);
            } catch (e) {
              this.logger.warn(`unable to resolve ${filename}`);
              return undefined;
            }
          })
          .filter(sourceComponentGuard);
      }
    }

    if (options?.origin === 'remote') {
      await this.ensureRemoteTracking();
      const remoteChanges = await this.remoteSourceTrackingService.retrieveUpdates();
      this.logger.debug('remoteChanges', remoteChanges);
      const filteredChanges = remoteChanges
        .filter(remoteFilterByState[options.state])
        // skip any remote types not in the registry.  Will emit warnings
        .filter((rce) => registrySupportsType(rce.type));
      if (options.format === 'ChangeResult') {
        return filteredChanges.map((change) => remoteChangeElementToChangeResult(change));
      }
      if (options.format === 'ChangeResultWithPaths') {
        return populateFilePaths(
          filteredChanges.map((change) => remoteChangeElementToChangeResult(change)),
          this.project.getPackageDirectories().map((pkgDir) => pkgDir.path)
        );
      }
      // turn it into a componentSet to resolve filenames
      const remoteChangesAsComponentSet = new ComponentSet(
        filteredChanges.map((element) => ({
          type: element?.type,
          fullName: element?.name,
        }))
      );
      const matchingLocalSourceComponentsSet = ComponentSet.fromSource({
        fsPaths: this.packagesDirs.map((dir) => resolve(dir.fullPath)),
        include: remoteChangesAsComponentSet,
      });
      if (options.format === 'string') {
        return matchingLocalSourceComponentsSet
          .getSourceComponents()
          .toArray()
          .flatMap((component) => [component.xml as string, ...component.walkContent()].filter((filename) => filename));
      } else if (options.format === 'SourceComponent') {
        return matchingLocalSourceComponentsSet.getSourceComponents().toArray();
      }
    }
    throw new Error(`unsupported options: ${JSON.stringify(options)}`);
  }

  /**
   *
   * Convenience method to reduce duplicated steps required to do a fka pull
   * It's full of side effects: retrieving remote deletes, deleting those files locall, and then updating tracking files
   * Most bizarrely, it then returns a ComponentSet of the remote nonDeletes.
   *
   * @returns the ComponentSet for what you would retrieve now that the deletes are done
   */

  public async maybeApplyRemoteDeletesToLocal(): Promise<ComponentSet> {
    const changesToDelete = await this.getChanges({ origin: 'remote', state: 'delete', format: 'SourceComponent' });
    await this.deleteFilesAndUpdateTracking(changesToDelete);
    return this.remoteNonDeletesAsComponentSet();
  }
  /**
   *
   * returns immediately if there are no changesToDelete
   *
   * @param changesToDelete array of SourceComponent
   */
  public async deleteFilesAndUpdateTracking(changesToDelete: SourceComponent[]): Promise<FileResponse[]> {
    if (changesToDelete.length === 0) {
      return [];
    }

    const sourceComponentByFileName = new Map<string, SourceComponent>();
    changesToDelete.flatMap((component) =>
      [component.xml as string, ...component.walkContent()]
        .filter((filename) => filename)
        .map((filename) => sourceComponentByFileName.set(filename, component))
    );
    const filenames = Array.from(sourceComponentByFileName.keys());
    // delete the files
    await Promise.all(filenames.map((filename) => fs.promises.unlink(filename)));

    // update the tracking files.  We're simulating SDR-style fileResponse
    await Promise.all([
      this.updateLocalTracking({ deletedFiles: filenames }),
      this.updateRemoteTracking(
        changesToDelete.map((component) => ({
          type: component.type.name,
          fullName: component.fullName,
          state: ComponentStatus.Deleted,
        })),
        true // skip polling because it's a pull
      ),
    ]);
    return filenames.map(
      (filename) =>
        ({
          state: 'Deleted',
          filename,
          type: sourceComponentByFileName.get(filename)?.type.name,
          fullName: sourceComponentByFileName.get(filename)?.fullName,
        } as unknown as FileResponse)
    );
  }

  /**
   * Update tracking for the options passed.
   *
   * @param options the files to update
   */
  public async updateLocalTracking(options: LocalUpdateOptions): Promise<void> {
    await this.ensureLocalTracking();

    // relative paths make smaller trees AND isogit wants them relative
    const relativeOptions = {
      files: (options.files ?? []).map((file) => ensureRelative(file, this.projectPath)),
      deletedFiles: (options.deletedFiles ?? []).map((file) => ensureRelative(file, this.projectPath)),
    };
    // plot twist: if you delete a member of a bundle (ex: lwc/foo/foo.css) and push, it'll not be in the fileResponses (deployedFiles) or deletedFiles
    // what got deleted?  Any local changes NOT in the fileResponses but part of a successfully deployed bundle
    const deployedFilesAsVirtualComponentSet = ComponentSet.fromSource({
      // resolve from highest possible level.  TODO: can we use [.]
      fsPaths: relativeOptions.files.length ? [relativeOptions.files[0].split(sep)[0]] : [],
      tree: VirtualTreeContainer.fromFilePaths(relativeOptions.files),
    });
    // these are top-level bundle paths like lwc/foo
    const bundlesWithDeletedFiles = (
      await this.getChanges({ origin: 'local', state: 'delete', format: 'SourceComponent' })
    )
      .filter(isBundle)
      .filter((cmp) => deployedFilesAsVirtualComponentSet.has({ type: cmp.type, fullName: cmp.fullName }))
      .map((cmp) => cmp.content)
      .filter(isString);

    await this.localRepo.commitChanges({
      deployedFiles: relativeOptions.files,
      deletedFiles: relativeOptions.deletedFiles.concat(
        (
          await this.localRepo.getDeleteFilenames()
        ).filter(
          (deployedFile) =>
            bundlesWithDeletedFiles.some((bundlePath) => pathIsInFolder(deployedFile, bundlePath)) &&
            !relativeOptions.files.includes(deployedFile)
        )
      ),
    });
  }

  /**
   * Mark remote source tracking files so say that we have received the latest version from the server
   * Optionall skip polling for the SourceMembers to exist on the server and be updated in local files
   */
  public async updateRemoteTracking(fileResponses: RemoteSyncInput[], skipPolling = false): Promise<void> {
    // false to explicitly NOT query until we do the polling
    await this.ensureRemoteTracking(false);
    if (!skipPolling) {
      // poll to make sure we have the updates before syncing the ones from metadataKeys
      await this.remoteSourceTrackingService.pollForSourceTracking(fileResponses);
    }
    await this.remoteSourceTrackingService.syncSpecifiedElements(fileResponses);
  }

  /**
   * If the local tracking shadowRepo doesn't exist, it will be created.
   * Does nothing if it already exists.
   * Useful before parallel operations
   */
  public async ensureLocalTracking(): Promise<void> {
    if (this.localRepo) {
      return;
    }
    this.localRepo = await ShadowRepo.getInstance({
      orgId: this.orgId,
      projectPath: normalize(this.projectPath),
      packageDirs: this.packagesDirs,
      hasSfdxTrackingFiles: this.hasSfdxTrackingFiles,
    });
    // loads the status from file so that it's cached
    await this.localRepo.getStatus();
  }

  /**
   * If the remote tracking shadowRepo doesn't exist, it will be created.
   * Does nothing if it already exists.
   * Useful before parallel operations
   */
  public async ensureRemoteTracking(initializeWithQuery = false): Promise<void> {
    if (this.remoteSourceTrackingService) {
      this.logger.debug('ensureRemoteTracking: remote tracking already exists');
      return;
    }
    this.logger.debug('ensureRemoteTracking: remote tracking does not exist yet; getting instance');
    this.remoteSourceTrackingService = await RemoteSourceTrackingService.getInstance({
      org: this.org,
      projectPath: this.projectPath,
      useSfdxTrackingFiles: this.hasSfdxTrackingFiles,
    });
    if (initializeWithQuery) {
      await this.remoteSourceTrackingService.retrieveUpdates();
    }
  }

  /**
   * Deletes the local tracking shadowRepo
   * return the list of files that were in it
   */
  public async clearLocalTracking(): Promise<string> {
    await this.ensureLocalTracking();
    return this.localRepo.delete();
  }

  /**
   * Commits all the local changes so that no changes are present in status
   */
  public async resetLocalTracking(): Promise<string[]> {
    await this.ensureLocalTracking();
    const [deletes, nonDeletes] = await Promise.all([
      this.localRepo.getDeleteFilenames(),
      this.localRepo.getNonDeleteFilenames(),
    ]);
    await this.localRepo.commitChanges({
      deletedFiles: deletes,
      deployedFiles: nonDeletes,
      message: 'via resetLocalTracking',
    });
    return [...deletes, ...nonDeletes];
  }

  /**
   * Deletes the remote tracking files
   */
  public async clearRemoteTracking(): Promise<string> {
    return RemoteSourceTrackingService.delete(this.orgId, this.hasSfdxTrackingFiles);
  }

  /**
   * Sets the files to max revision so that no changes appear
   */
  public async resetRemoteTracking(serverRevision?: number): Promise<number> {
    await this.ensureRemoteTracking();
    const resetMembers = await this.remoteSourceTrackingService.reset(serverRevision);
    return resetMembers.length;
  }

  /**
   * Compares local and remote changes to detect conflicts
   */
  public async getConflicts(): Promise<ChangeResult[]> {
    // we're going to need have both initialized
    await Promise.all([this.ensureRemoteTracking(), this.ensureLocalTracking()]);

    // Strategy: check local changes first (since it'll be faster) to avoid callout
    // early return if either local or remote is empty
    const localChanges = await this.getChanges({
      state: 'nondelete',
      origin: 'local',
      format: 'ChangeResult',
    });
    if (localChanges.length === 0) {
      return [];
    }
    const remoteChanges = await this.getChanges({
      origin: 'remote',
      state: 'nondelete',
      // remote adds won't have a filename, so we ask for it to be resolved
      format: 'ChangeResultWithPaths',
    });
    if (remoteChanges.length === 0) {
      return [];
    }
    this.forceIgnore ??= ForceIgnore.findAndCreate(this.project.getDefaultPackage().path);

    return dedupeConflictChangeResults({
      localChanges,
      remoteChanges,
      projectPath: this.projectPath,
      forceIgnore: this.forceIgnore,
    });
  }

  /**
   * handles both remote and local tracking
   *
   * @param result FileResponse[]
   */
  public async updateTrackingFromDeploy(deployResult: DeployResult): Promise<void> {
    const successes = deployResult
      .getFileResponses()
      .filter((fileResponse) => fileResponse.state !== ComponentStatus.Failed && fileResponse.filePath);
    if (!successes.length) {
      return;
    }

    await Promise.all([
      this.updateLocalTracking({
        // assertions allowed because filtered above
        files: successes
          .filter((fileResponse) => fileResponse.state !== ComponentStatus.Deleted)
          .map((fileResponse) => fileResponse.filePath as string),
        deletedFiles: successes
          .filter((fileResponse) => fileResponse.state === ComponentStatus.Deleted)
          .map((fileResponse) => fileResponse.filePath as string),
      }),
      this.updateRemoteTracking(
        successes.map(({ state, fullName, type, filePath }) => ({ state, fullName, type, filePath }))
      ),
    ]);
  }

  /**
   * handles both remote and local tracking
   *
   * @param result FileResponse[]
   */
  public async updateTrackingFromRetrieve(retrieveResult: RetrieveResult): Promise<void> {
    const successes = retrieveResult
      .getFileResponses()
      .filter((fileResponse) => fileResponse.state !== ComponentStatus.Failed);
    if (!successes.length) {
      return;
    }

    await Promise.all([
      this.updateLocalTracking({
        // assertion allowed because it's filtering out undefined
        files: successes.map((fileResponse) => fileResponse.filePath as string).filter(Boolean),
      }),
      this.updateRemoteTracking(
        successes.map(({ state, fullName, type, filePath }) => ({ state, fullName, type, filePath })),
        true // retrieves don't need to poll for SourceMembers
      ),
    ]);
  }

  /**
   * If you've already got an instance of STL, but need to change the conflicts setting
   * normally you set this on instantiation
   *
   * @param value true/false
   */
  public setIgnoreConflicts(value: boolean): void {
    this.ignoreConflicts = value;
  }

  private maybeSubscribeLifecycleEvents(): void {
    if (this.subscribeSDREvents && this.org.tracksSource) {
      const lifecycle = Lifecycle.getInstance();
      // the only thing STL uses pre events for is to check conflicts.  So if you don't care about conflicts, don't listen!
      if (!this.ignoreConflicts) {
        this.logger.debug('subscribing to predeploy/retrieve events');
        // subscribe to SDR `pre` events to handle conflicts before deploy/retrieve
        lifecycle.on('scopedPreDeploy', async (e: ScopedPreDeploy) => {
          if (e.orgId === this.orgId) {
            throwIfConflicts(findConflictsInComponentSet(e.componentSet, await this.getConflicts()));
          }
        });
        lifecycle.on('scopedPreRetrieve', async (e: ScopedPreRetrieve) => {
          if (e.orgId === this.orgId) {
            throwIfConflicts(findConflictsInComponentSet(e.componentSet, await this.getConflicts()));
          }
        });
      }
      // subscribe to SDR post-deploy event
      this.logger.debug('subscribing to postdeploy/retrieve events');

      // yes, the post hooks really have different payloads!
      lifecycle.on('scopedPostDeploy', async (e: ScopedPostDeploy) => {
        if (e.orgId === this.orgId) {
          await this.updateTrackingFromDeploy(e.deployResult);
        }
      });
      lifecycle.on('scopedPostRetrieve', async (e: ScopedPostRetrieve) => {
        if (e.orgId === this.orgId) {
          await this.updateTrackingFromRetrieve(e.retrieveResult);
        }
      });
    }
  }

  private async getLocalStatusRows(): Promise<StatusOutputRow[]> {
    await this.ensureLocalTracking();

    let results: StatusOutputRow[] = [];
    const localDeletes = populateTypesAndNames({
      elements: await this.getChanges({ origin: 'local', state: 'delete', format: 'ChangeResult' }),
      excludeUnresolvable: true,
      resolveDeleted: true,
      projectPath: this.projectPath,
    });

    const localAdds = populateTypesAndNames({
      elements: await this.getChanges({ origin: 'local', state: 'add', format: 'ChangeResult' }),
      excludeUnresolvable: true,
      projectPath: this.projectPath,
    });

    const localModifies = populateTypesAndNames({
      elements: await this.getChanges({ origin: 'local', state: 'modify', format: 'ChangeResult' }),
      excludeUnresolvable: true,
      projectPath: this.projectPath,
    });

    results = results.concat(
      localAdds.flatMap((item) => this.localChangesToOutputRow(item, 'add')),
      localModifies.flatMap((item) => this.localChangesToOutputRow(item, 'modify')),
      localDeletes.flatMap((item) => this.localChangesToOutputRow(item, 'delete'))
    );
    return results;
  }

  private async getLocalChangesAsFilenames(state: ChangeOptions['state']): Promise<string[]> {
    if (state === 'modify') {
      return this.localRepo.getModifyFilenames();
    }
    if (state === 'nondelete') {
      return this.localRepo.getNonDeleteFilenames();
    }
    if (state === 'delete') {
      return this.localRepo.getDeleteFilenames();
    }
    if (state === 'add') {
      return this.localRepo.getAddFilenames();
    }
    throw new Error(`unable to get local changes for state ${state as string}`);
  }

  private localChangesToOutputRow(input: ChangeResult, localType: 'delete' | 'modify' | 'add'): StatusOutputRow[] {
    this.logger.debug('converting ChangeResult to a row', input);

    const baseObject = {
      type: input.type ?? '',
      origin: 'local',
      state: localType,
      fullName: input.name ?? '',
      // ignored property will be set in populateTypesAndNames
      ignored: input.ignored ?? false,
    };

    if (input.filenames) {
      return input.filenames.map((filename) => ({
        ...baseObject,
        filePath: filename,
        origin: 'local',
      }));
    }
    throw new Error('no filenames found for local ChangeResult');
  }

  // this will eventually have async call to figure out the target file locations for remote changes
  // eslint-disable-next-line @typescript-eslint/require-await
  private async remoteChangesToOutputRows(input: ChangeResult): Promise<StatusOutputRow[]> {
    this.logger.debug('converting ChangeResult to a row', input);
    this.forceIgnore ??= ForceIgnore.findAndCreate(this.project.getDefaultPackage().path);
    const baseObject: StatusOutputRow = {
      type: input.type ?? '',
      origin: input.origin,
      state: stateFromChangeResult(input),
      fullName: input.name ?? '',
    };
    // it's easy to check ignores if the filePaths exist locally
    if (input.filenames?.length) {
      return input.filenames.map((filename) => ({
        ...baseObject,
        filePath: filename,
        ignored: this.forceIgnore.denies(filename),
      }));
    }
    // when the file doesn't exist locally, there are no filePaths
    // So we can't say whether it's ignored or not
    return [baseObject];
  }
}

const remoteFilterByState = {
  add: (change: RemoteChangeElement): boolean => !change.deleted && !change.modified,
  modify: (change: RemoteChangeElement): boolean => change.modified === true,
  delete: (change: RemoteChangeElement): boolean => change.deleted === true,
  nondelete: (change: RemoteChangeElement): boolean => !change.deleted,
};

const stateFromChangeResult = (input: ChangeResult): 'add' | 'delete' | 'modify' => {
  if (input.deleted) {
    return 'delete';
  }
  if (input.modified) {
    return 'modify';
  }
  return 'add';
};
