// @flow
import chalk from 'chalk';
import { BitId } from '../../../bit-id';
import Component from '../../component';
import { Version } from '../../../scope/models';
import { Consumer } from '../..';
import { SourceFile } from '../../component/sources';
import type { SourceFileModel } from '../../../scope/models/version';
import { resolveConflictPrompt } from '../../../prompts';
import { pathNormalizeToLinux } from '../../../utils/path';
import twoWayMergeVersions from './two-way-merge';
import type { MergeResultsTwoWay } from './two-way-merge';
import type { PathLinux } from '../../../utils/path';
import { COMPONENT_ORIGINS } from '../../../constants';

export const mergeOptionsCli = { o: 'ours', t: 'theirs', m: 'manual' };
export const MergeOptions = { ours: 'ours', theirs: 'theirs', manual: 'manual' };
export type MergeStrategy = $Keys<typeof MergeOptions>;
export const FileStatus = {
  merged: chalk.green('auto-merged'),
  manual: chalk.red('CONFLICT'),
  updated: chalk.green('updated'),
  added: chalk.green('added'),
  overridden: chalk.yellow('overridden'),
  unchanged: chalk.green('unchanged')
};
export type ApplyVersionResult = { id: BitId, filesStatus: { [fileName: PathLinux]: $Values<typeof FileStatus> } };
export type ApplyVersionResults = { components: ApplyVersionResult[], version: string };
type ComponentStatus = {
  componentFromFS: Component,
  id: BitId,
  mergeResults: MergeResultsTwoWay
};

export async function mergeVersion(
  consumer: Consumer,
  version: string,
  ids: BitId[],
  mergeStrategy: MergeStrategy
): Promise<ApplyVersionResults> {
  const { components } = await consumer.loadComponents(ids);
  const componentsStatusP = components.map((component: Component) => {
    return getComponentStatus(consumer, component, version);
  });
  const componentsStatus = await Promise.all(componentsStatusP);
  const componentWithConflict = componentsStatus.find(component => component.mergeResults.hasConflicts);
  if (componentWithConflict && !mergeStrategy) {
    mergeStrategy = await getMergeStrategyInteractive();
  }
  const mergedComponentsP = componentsStatus.map(({ id, componentFromFS, mergeResults }) => {
    return applyVersion(consumer, id, componentFromFS, mergeResults, mergeStrategy);
  });
  const mergedComponents = await Promise.all(mergedComponentsP);
  await consumer.bitMap.write();

  return { components: mergedComponents, version };
}

async function getComponentStatus(consumer: Consumer, component: Component, version: string): Promise<ComponentStatus> {
  const componentModel = await consumer.scope.sources.get(component.id);
  if (!componentModel) {
    throw new Error(`component ${component.id.toString()} doesn't have any version yet`);
  }
  if (!componentModel.hasVersion(version)) {
    throw new Error(`component ${component.id.toStringWithoutVersion()} doesn't have version ${version}`);
  }
  const existingBitMapId = consumer.bitMap.getExistingComponentId(component.id.toStringWithoutVersion());
  const currentlyUsedVersion = BitId.parse(existingBitMapId).version;
  if (currentlyUsedVersion === version) {
    throw new Error(`component ${component.id.toStringWithoutVersion()} is already at version ${version}`);
  }
  const otherComponent: Version = await componentModel.loadVersion(version, consumer.scope.objects);
  const mergeResults: MergeResultsTwoWay = await twoWayMergeVersions({
    consumer,
    otherComponent,
    otherVersion: version,
    currentComponent: component,
    currentVersion: currentlyUsedVersion
  });
  return { componentFromFS: component, id: component.id, mergeResults };
}

/**
 * it doesn't matter whether the component is modified. the idea is to merge the
 * specified version with the current version.
 *
 * 1) when there are conflicts and the strategy is "ours", don't do any change to the component.
 *
 * 2) when there are conflicts and the strategy is "theirs", add all files from the specified
 * version and write the component.
 *
 * 3) when there is no conflict or there are conflicts and the strategy is manual, update
 * component.files.
 *
 * it's going to be 2-way merge:
 * current-file: is the current file.
 * base-file: empty.
 * other-file: the specified version.
 */
async function applyVersion(
  consumer: Consumer,
  id: BitId,
  componentFromFS: Component,
  mergeResults: MergeResultsTwoWay,
  mergeStrategy: MergeStrategy
): Promise<ApplyVersionResult> {
  const filesStatus = {};
  if (mergeResults.hasConflicts && mergeStrategy === MergeOptions.ours) {
    componentFromFS.files.forEach((file) => {
      filesStatus[pathNormalizeToLinux(file.relative)] = FileStatus.unchanged;
    });
    return { id, filesStatus };
  }
  const component = componentFromFS.componentFromModel;
  if (!component) throw new Error('failed finding the component in the model');
  const componentMap = componentFromFS.componentMap;
  if (!componentMap) throw new Error('applyVersion: componentMap was not found');
  const files = componentFromFS.cloneFilesWithSharedDir();
  component.files = files;

  files.forEach((file) => {
    filesStatus[pathNormalizeToLinux(file.relative)] = FileStatus.unchanged;
  });

  // update files according to the merge results
  const modifiedStatus = await applyModifiedVersion(consumer, files, mergeResults, mergeStrategy);

  if (componentMap.origin === COMPONENT_ORIGINS.IMPORTED) {
    component.originallySharedDir = componentMap.originallySharedDir || null;
    component.stripOriginallySharedDir(consumer.bitMap);
  }

  await component.write({
    force: true,
    writeBitJson: false, // never override the existing bit.json
    writePackageJson: false,
    deleteBitDirContent: false,
    origin: componentMap.origin,
    consumer,
    componentMap
  });

  consumer.bitMap.removeComponent(component.id);
  component._addComponentToBitMap(consumer.bitMap, componentMap.rootDir, componentMap.origin);

  return { id, filesStatus: Object.assign(filesStatus, modifiedStatus) };
}

/**
 * relevant when
 * 1) there is no conflict => add files from mergeResults: addFiles, overrideFiles and modifiedFiles.output.
 * 2) there is conflict and mergeStrategy is manual => add files from mergeResults: addFiles, overrideFiles and modifiedFiles.conflict.
 */
async function applyModifiedVersion(
  consumer: Consumer,
  componentFiles: SourceFile[],
  mergeResults: MergeResultsTwoWay,
  mergeStrategy: ?MergeStrategy
): Promise<Object> {
  const filesStatus = {};
  const modifiedP = mergeResults.modifiedFiles.map(async (file) => {
    const foundFile = componentFiles.find(componentFile => componentFile.relative === file.filePath);
    if (!foundFile) throw new Error(`file ${file.filePath} not found`);
    if (mergeResults.hasConflicts && mergeStrategy === MergeOptions.theirs) {
      // write the version of otherFile
      const otherFile: SourceFileModel = file.otherFile;
      // $FlowFixMe
      const content = await otherFile.file.load(consumer.scope.objects);
      foundFile.contents = content.contents;
      filesStatus[file.filePath] = FileStatus.updated;
    } else if (file.conflict) {
      foundFile.contents = new Buffer(file.conflict);
      filesStatus[file.filePath] = FileStatus.manual;
    } else if (file.output) {
      foundFile.contents = new Buffer(file.output);
      filesStatus[file.filePath] = FileStatus.merged;
    } else {
      throw new Error('file does not have output nor conflict');
    }
  });
  const addFilesP = mergeResults.addFiles.map(async (file) => {
    const otherFile: SourceFileModel = file.otherFile;
    const newFile = await SourceFile.loadFromSourceFileModel(otherFile, consumer.scope.objects);
    componentFiles.push(newFile);
    filesStatus[file.filePath] = FileStatus.added;
  });

  await Promise.all([Promise.all(modifiedP), Promise.all(addFilesP)]);

  return filesStatus;
}

export async function getMergeStrategyInteractive(): Promise<MergeStrategy> {
  try {
    const result = await resolveConflictPrompt();
    return mergeOptionsCli[result.mergeStrategy];
  } catch (err) {
    // probably user clicked ^C
    throw new Error('the action has been canceled');
  }
}

export function getMergeStrategy(ours: boolean, theirs: boolean, manual: boolean): ?MergeStrategy {
  if ((ours && theirs) || (ours && manual) || (theirs && manual)) {
    throw new Error('please choose only one of the following: ours, theirs or manual');
  }
  if (ours) return MergeOptions.ours;
  if (theirs) return MergeOptions.theirs;
  if (manual) return MergeOptions.manual;
  return null;
}
