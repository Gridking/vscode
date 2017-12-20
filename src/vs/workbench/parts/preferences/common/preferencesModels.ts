/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { assign } from 'vs/base/common/objects';
import { tail, flatten, fill } from 'vs/base/common/arrays';
import URI from 'vs/base/common/uri';
import * as strings from 'vs/base/common/strings';
import { IReference, Disposable } from 'vs/base/common/lifecycle';
import Event, { Emitter } from 'vs/base/common/event';
import { Registry } from 'vs/platform/registry/common/platform';
import { visit, JSONVisitor } from 'vs/base/common/json';
import { IModel } from 'vs/editor/common/editorCommon';
import { EditorModel } from 'vs/workbench/common/editor';
import { IConfigurationNode, IConfigurationRegistry, Extensions, OVERRIDE_PROPERTY_PATTERN, IConfigurationPropertySchema, ConfigurationScope } from 'vs/platform/configuration/common/configurationRegistry';
import { ISettingsEditorModel, IKeybindingsEditorModel, ISettingsGroup, ISetting, IFilterResult, ISettingsSection, IGroupFilter, ISettingMatcher, IFilterMatch } from 'vs/workbench/parts/preferences/common/preferences';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { ITextEditorModel } from 'vs/editor/common/services/resolverService';
import { IRange, Range } from 'vs/editor/common/core/range';
import { ConfigurationTarget } from 'vs/platform/configuration/common/configuration';

export abstract class AbstractSettingsModel extends EditorModel {

	public get groupsTerms(): string[] {
		return this.settingsGroups.map(group => '@' + group.id);
	}

	public filterSettings(filter: string, groupFilter: IGroupFilter, settingMatcher: ISettingMatcher): IFilterMatch[] {
		const allGroups = this.settingsGroups;

		if (!filter) {
			throw new Error(`don't`);
			// return {
			// 	filteredGroups: allGroups,
			// 	allGroups,
			// 	matches: [],
			// 	query: filter
			// };
		}

		// Hm
		// const group = this.filterByGroupTerm(filter);
		// if (group) {
		// 	return {
		// 		filteredGroups: [group],
		// 		allGroups,
		// 		matches: [],
		// 		query: filter
		// 	};
		// }

		const filterMatches: IFilterMatch[] = [];
		const matches: IRange[] = [];
		// const filteredGroups: ISettingsGroup[] = [];
		for (const group of allGroups) {
			const groupMatched = groupFilter(group);
			for (const section of group.sections) {
				for (const setting of section.settings) {
					const settingMatches = settingMatcher(setting).map(range => {
						return new Range(
							range.startLineNumber - setting.range.startLineNumber,
							range.startColumn,
							range.endLineNumber - setting.range.startLineNumber,
							range.endColumn
						);
					});

					if (groupMatched || settingMatches && settingMatches.length) {
						filterMatches.push({ setting, matches: settingMatches });
					}

					if (settingMatches) {
						matches.push(...settingMatches);
					}
				}
				// if (settings.length) {
				// 	sections.push({
				// 		title: section.title,
				// 		settings,
				// 		titleRange: section.titleRange
				// 	});
				// }
			}
			// if (sections.length) {
			// 	filteredGroups.push({
			// 		id: group.id,
			// 		title: group.title,
			// 		titleRange: group.titleRange,
			// 		sections,
			// 		range: group.range
			// 	});
			// }
		}

		return filterMatches;
	}

	private filterByGroupTerm(filter: string): ISettingsGroup {
		if (this.groupsTerms.indexOf(filter) !== -1) {
			const id = filter.substring(1);
			return this.settingsGroups.filter(group => group.id === id)[0];
		}
		return null;
	}

	public getPreference(key: string): ISetting {
		for (const group of this.settingsGroups) {
			for (const section of group.sections) {
				for (const setting of section.settings) {
					if (key === setting.key) {
						return setting;
					}
				}
			}
		}
		return null;
	}

	public abstract settingsGroups: ISettingsGroup[];

	public abstract findValueMatches(filter: string, setting: ISetting): IRange[];
}

export class SettingsEditorModel extends AbstractSettingsModel implements ISettingsEditorModel {

	private _settingsGroups: ISettingsGroup[];
	protected settingsModel: IModel;

	private _onDidChangeGroups: Emitter<void> = this._register(new Emitter<void>());
	readonly onDidChangeGroups: Event<void> = this._onDidChangeGroups.event;

	constructor(reference: IReference<ITextEditorModel>, private _configurationTarget: ConfigurationTarget) {
		super();
		this.settingsModel = reference.object.textEditorModel;
		this._register(this.onDispose(() => reference.dispose()));
		this._register(this.settingsModel.onDidChangeContent(() => {
			this._settingsGroups = null;
			this._onDidChangeGroups.fire();
		}));
	}

	public get uri(): URI {
		return this.settingsModel.uri;
	}

	public get configurationTarget(): ConfigurationTarget {
		return this._configurationTarget;
	}

	public get settingsGroups(): ISettingsGroup[] {
		if (!this._settingsGroups) {
			this.parse();
		}
		return this._settingsGroups;
	}

	public get content(): string {
		return this.settingsModel.getValue();
	}

	// public filterSettings(filter: string, groupFilter: IGroupFilter, settingMatcher: ISettingMatcher): ISetting[] {
	// 	return this.doFilterSettings(filter, groupFilter, settingMatcher);
	// }

	renderFilteredMatches(filteredMatches: IFilterMatch[], filter: string): IFilterResult {
		return {
			allGroups: this.settingsGroups,
			filteredGroups: this.settingsGroups,
			matches: flatten(filteredMatches.map(m => m.matches)),
			query: filter
		};
	}

	renderSearchMatches(searchMatches: IFilterMatch[], filter: string): IFilterResult {
		return {
			allGroups: this.settingsGroups,
			filteredGroups: this.settingsGroups,
			matches: flatten(searchMatches.map(m => m.matches)),
			query: filter
		};
	}

	public findValueMatches(filter: string, setting: ISetting): IRange[] {
		return this.settingsModel.findMatches(filter, setting.valueRange, false, false, null, false).map(match => match.range);
	}

	protected isSettingsProperty(property: string, previousParents: string[]): boolean {
		return previousParents.length === 0; // Settings is root
	}

	protected parse(): void {
		this._settingsGroups = parse(this.settingsModel, (property: string, previousParents: string[]): boolean => this.isSettingsProperty(property, previousParents));
	}
}

function parse(model: IModel, isSettingsProperty: (currentProperty: string, previousParents: string[]) => boolean): ISettingsGroup[] {
	const settings: ISetting[] = [];
	let overrideSetting: ISetting = null;

	let currentProperty: string = null;
	let currentParent: any = [];
	let previousParents: any[] = [];
	let settingsPropertyIndex: number = -1;
	let range = {
		startLineNumber: 0,
		startColumn: 0,
		endLineNumber: 0,
		endColumn: 0
	};

	function onValue(value: any, offset: number, length: number) {
		if (Array.isArray(currentParent)) {
			(<any[]>currentParent).push(value);
		} else if (currentProperty) {
			currentParent[currentProperty] = value;
		}
		if (previousParents.length === settingsPropertyIndex + 1 || (previousParents.length === settingsPropertyIndex + 2 && overrideSetting !== null)) {
			// settings value started
			const setting = previousParents.length === settingsPropertyIndex + 1 ? settings[settings.length - 1] : overrideSetting.overrides[overrideSetting.overrides.length - 1];
			if (setting) {
				let valueStartPosition = model.getPositionAt(offset);
				let valueEndPosition = model.getPositionAt(offset + length);
				setting.value = value;
				setting.valueRange = {
					startLineNumber: valueStartPosition.lineNumber,
					startColumn: valueStartPosition.column,
					endLineNumber: valueEndPosition.lineNumber,
					endColumn: valueEndPosition.column
				};
				setting.range = assign(setting.range, {
					endLineNumber: valueEndPosition.lineNumber,
					endColumn: valueEndPosition.column
				});
			}
		}
	}
	let visitor: JSONVisitor = {
		onObjectBegin: (offset: number, length: number) => {
			if (isSettingsProperty(currentProperty, previousParents)) {
				// Settings started
				settingsPropertyIndex = previousParents.length;
				let position = model.getPositionAt(offset);
				range.startLineNumber = position.lineNumber;
				range.startColumn = position.column;
			}
			let object = {};
			onValue(object, offset, length);
			currentParent = object;
			currentProperty = null;
			previousParents.push(currentParent);
		},
		onObjectProperty: (name: string, offset: number, length: number) => {
			currentProperty = name;
			if (previousParents.length === settingsPropertyIndex + 1 || (previousParents.length === settingsPropertyIndex + 2 && overrideSetting !== null)) {
				// setting started
				let settingStartPosition = model.getPositionAt(offset);
				const setting: ISetting = {
					description: [],
					key: name,
					keyRange: {
						startLineNumber: settingStartPosition.lineNumber,
						startColumn: settingStartPosition.column + 1,
						endLineNumber: settingStartPosition.lineNumber,
						endColumn: settingStartPosition.column + length
					},
					range: {
						startLineNumber: settingStartPosition.lineNumber,
						startColumn: settingStartPosition.column,
						endLineNumber: 0,
						endColumn: 0
					},
					value: null,
					valueRange: null,
					descriptionRanges: null,
					overrides: [],
					overrideOf: overrideSetting
				};
				if (previousParents.length === settingsPropertyIndex + 1) {
					settings.push(setting);
					if (OVERRIDE_PROPERTY_PATTERN.test(name)) {
						overrideSetting = setting;
					}
				} else {
					overrideSetting.overrides.push(setting);
				}
			}
		},
		onObjectEnd: (offset: number, length: number) => {
			currentParent = previousParents.pop();
			if (previousParents.length === settingsPropertyIndex + 1 || (previousParents.length === settingsPropertyIndex + 2 && overrideSetting !== null)) {
				// setting ended
				const setting = previousParents.length === settingsPropertyIndex + 1 ? settings[settings.length - 1] : overrideSetting.overrides[overrideSetting.overrides.length - 1];
				if (setting) {
					let valueEndPosition = model.getPositionAt(offset + length);
					setting.valueRange = assign(setting.valueRange, {
						endLineNumber: valueEndPosition.lineNumber,
						endColumn: valueEndPosition.column
					});
					setting.range = assign(setting.range, {
						endLineNumber: valueEndPosition.lineNumber,
						endColumn: valueEndPosition.column
					});
				}

				if (previousParents.length === settingsPropertyIndex + 1) {
					overrideSetting = null;
				}
			}
			if (previousParents.length === settingsPropertyIndex) {
				// settings ended
				let position = model.getPositionAt(offset);
				range.endLineNumber = position.lineNumber;
				range.endColumn = position.column;
			}
		},
		onArrayBegin: (offset: number, length: number) => {
			let array: any[] = [];
			onValue(array, offset, length);
			previousParents.push(currentParent);
			currentParent = array;
			currentProperty = null;
		},
		onArrayEnd: (offset: number, length: number) => {
			currentParent = previousParents.pop();
			if (previousParents.length === settingsPropertyIndex + 1 || (previousParents.length === settingsPropertyIndex + 2 && overrideSetting !== null)) {
				// setting value ended
				const setting = previousParents.length === settingsPropertyIndex + 1 ? settings[settings.length - 1] : overrideSetting.overrides[overrideSetting.overrides.length - 1];
				if (setting) {
					let valueEndPosition = model.getPositionAt(offset + length);
					setting.valueRange = assign(setting.valueRange, {
						endLineNumber: valueEndPosition.lineNumber,
						endColumn: valueEndPosition.column
					});
					setting.range = assign(setting.range, {
						endLineNumber: valueEndPosition.lineNumber,
						endColumn: valueEndPosition.column
					});
				}
			}
		},
		onLiteralValue: onValue,
		onError: (error) => {
			const setting = settings[settings.length - 1];
			if (setting && (!setting.range || !setting.keyRange || !setting.valueRange)) {
				settings.pop();
			}
		}
	};
	if (!model.isDisposed()) {
		visit(model.getValue(), visitor);
	}
	return settings.length > 0 ? [<ISettingsGroup>{
		sections: [
			{
				settings
			}
		],
		title: null,
		titleRange: null,
		range
	}] : [];
}

export class WorkspaceConfigurationEditorModel extends SettingsEditorModel {

	private _configurationGroups: ISettingsGroup[];

	get configurationGroups(): ISettingsGroup[] {
		return this._configurationGroups;
	}

	protected parse(): void {
		super.parse();
		this._configurationGroups = parse(this.settingsModel, (property: string, previousParents: string[]): boolean => previousParents.length === 0);
	}

	protected isSettingsProperty(property: string, previousParents: string[]): boolean {
		return property === 'settings' && previousParents.length === 1;
	}

}

export class DefaultSettings extends Disposable {

	private static _RAW: string;

	private _allSettingsGroups: ISettingsGroup[];
	private _content: string;
	private _settingsByName: Map<string, ISetting>;

	readonly _onDidChange: Emitter<void> = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(
		private _mostCommonlyUsedSettingsKeys: string[],
		readonly configurationScope: ConfigurationScope,
	) {
		super();
	}

	get content(): string {
		if (!this._content) {
			this.parse();
		}
		return this._content;
	}

	get settingsGroups(): ISettingsGroup[] {
		if (!this._allSettingsGroups) {
			this.parse();
		}
		return this._allSettingsGroups;
	}

	parse(): string {
		const settingsGroups = this.getRegisteredGroups();
		this.initAllSettingsMap(settingsGroups);
		const mostCommonlyUsed = this.getMostCommonlyUsedSettings(settingsGroups);
		this._allSettingsGroups = [mostCommonlyUsed, ...settingsGroups];
		this._content = this.toContent(true, [mostCommonlyUsed], settingsGroups);
		return this._content;
	}

	get raw(): string {
		if (!DefaultSettings._RAW) {
			DefaultSettings._RAW = this.toContent(false, this.getRegisteredGroups());
		}
		return DefaultSettings._RAW;
	}

	getSettingByName(name: string): ISetting {
		return this._settingsByName && this._settingsByName.get(name);
	}

	private getRegisteredGroups(): ISettingsGroup[] {
		const configurations = Registry.as<IConfigurationRegistry>(Extensions.Configuration).getConfigurations().slice();
		return this.removeEmptySettingsGroups(configurations.sort(this.compareConfigurationNodes)
			.reduce((result, config, index, array) => this.parseConfig(config, result, array), []));
	}

	private initAllSettingsMap(allSettingsGroups: ISettingsGroup[]): void {
		this._settingsByName = new Map<string, ISetting>();
		for (const group of allSettingsGroups) {
			for (const section of group.sections) {
				for (const setting of section.settings) {
					this._settingsByName.set(setting.key, setting);
				}
			}
		}
	}

	private getMostCommonlyUsedSettings(allSettingsGroups: ISettingsGroup[]): ISettingsGroup {
		const settings = this._mostCommonlyUsedSettingsKeys.map(key => {
			const setting = this._settingsByName.get(key);
			if (setting) {
				return <ISetting>{
					description: setting.description,
					key: setting.key,
					value: setting.value,
					range: null,
					valueRange: null,
					overrides: []
				};
			}
			return null;
		}).filter(setting => !!setting);

		return <ISettingsGroup>{
			id: 'mostCommonlyUsed',
			range: null,
			title: nls.localize('commonlyUsed', "Commonly Used"),
			titleRange: null,
			sections: [
				{
					settings
				}
			]
		};
	}

	private parseConfig(config: IConfigurationNode, result: ISettingsGroup[], configurations: IConfigurationNode[], settingsGroup?: ISettingsGroup): ISettingsGroup[] {
		let title = config.title;
		if (!title) {
			const configWithTitleAndSameId = configurations.filter(c => c.id === config.id && c.title)[0];
			if (configWithTitleAndSameId) {
				title = configWithTitleAndSameId.title;
			}
		}
		if (title) {
			if (!settingsGroup) {
				settingsGroup = result.filter(g => g.title === title)[0];
				if (!settingsGroup) {
					settingsGroup = { sections: [{ settings: [] }], id: config.id, title: title, titleRange: null, range: null };
					result.push(settingsGroup);
				}
			} else {
				settingsGroup.sections[settingsGroup.sections.length - 1].title = title;
			}
		}
		if (config.properties) {
			if (!settingsGroup) {
				settingsGroup = { sections: [{ settings: [] }], id: config.id, title: config.id, titleRange: null, range: null };
				result.push(settingsGroup);
			}
			const configurationSettings: ISetting[] = [...settingsGroup.sections[settingsGroup.sections.length - 1].settings, ...this.parseSettings(config.properties)];
			if (configurationSettings.length) {
				configurationSettings.sort((a, b) => a.key.localeCompare(b.key));
				settingsGroup.sections[settingsGroup.sections.length - 1].settings = configurationSettings;
			}
		}
		if (config.allOf) {
			config.allOf.forEach(c => this.parseConfig(c, result, configurations, settingsGroup));
		}
		return result;
	}

	private removeEmptySettingsGroups(settingsGroups: ISettingsGroup[]): ISettingsGroup[] {
		const result = [];
		for (const settingsGroup of settingsGroups) {
			settingsGroup.sections = settingsGroup.sections.filter(section => section.settings.length > 0);
			if (settingsGroup.sections.length) {
				result.push(settingsGroup);
			}
		}
		return result;
	}

	private parseSettings(settingsObject: { [path: string]: IConfigurationPropertySchema; }): ISetting[] {
		let result = [];
		for (let key in settingsObject) {
			const prop = settingsObject[key];
			if (!prop.deprecationMessage && this.matchesScope(prop)) {
				const value = prop.default;
				const description = (prop.description || '').split('\n');
				const overrides = OVERRIDE_PROPERTY_PATTERN.test(key) ? this.parseOverrideSettings(prop.default) : [];
				result.push({ key, value, description, range: null, keyRange: null, valueRange: null, descriptionRanges: [], overrides });
			}
		}
		return result;
	}

	private parseOverrideSettings(overrideSettings: any): ISetting[] {
		return Object.keys(overrideSettings).map((key) => ({ key, value: overrideSettings[key], description: [], range: null, keyRange: null, valueRange: null, descriptionRanges: [], overrides: [] }));
	}

	private matchesScope(property: IConfigurationNode): boolean {
		if (this.configurationScope === ConfigurationScope.WINDOW) {
			return true;
		}
		return property.scope === this.configurationScope;
	}

	private compareConfigurationNodes(c1: IConfigurationNode, c2: IConfigurationNode): number {
		if (typeof c1.order !== 'number') {
			return 1;
		}
		if (typeof c2.order !== 'number') {
			return -1;
		}
		if (c1.order === c2.order) {
			const title1 = c1.title || '';
			const title2 = c2.title || '';
			return title1.localeCompare(title2);
		}
		return c1.order - c2.order;
	}

	private toContent(asArray: boolean, ...settingsGroups: ISettingsGroup[][]): string {
		const builder = new SettingsContentBuilder();
		if (asArray) {
			builder.pushLine('[');
		}
		settingsGroups.forEach((settingsGroup, i) => {
			builder.pushGroups(settingsGroup);

			if (i !== settingsGroups.length - 1) {
				builder.pushLine(',');
			}
		});
		if (asArray) {
			builder.pushLine(']');
		}
		return builder.getContent();
	}

}

export class DefaultSettingsEditorModel extends AbstractSettingsModel implements ISettingsEditorModel {
	private static readonly GROUP_SIZE = 1000;

	private _model: IModel;

	private _onDidChangeGroups: Emitter<void> = this._register(new Emitter<void>());
	readonly onDidChangeGroups: Event<void> = this._onDidChangeGroups.event;

	// private _filterGroupRange: Range;
	// private _searchGroupRange: Range;
	private _filterGroupStartLine = 0;
	private _searchGroupStartLine = 0;

	constructor(
		private _uri: URI,
		reference: IReference<ITextEditorModel>,
		readonly configurationScope: ConfigurationScope,
		private readonly defaultSettings: DefaultSettings
	) {
		super();

		this._register(defaultSettings.onDidChange(() => this._onDidChangeGroups.fire()));
		this._model = reference.object.textEditorModel;
		this._register(this.onDispose(() => reference.dispose()));
	}

	public get uri(): URI {
		return this._uri;
	}

	public get settingsGroups(): ISettingsGroup[] {
		return this.defaultSettings.settingsGroups;
	}

	renderSearchMatches(searchMatches: IFilterMatch[], filter: string): IFilterResult {
		if (!this._searchGroupStartLine) {
			this._searchGroupStartLine = this._filterGroupStartLine + DefaultSettingsEditorModel.GROUP_SIZE;
		}

		const searchGroup = this.getSearchResultsGroup(searchMatches.map(m => m.setting));
		const fixedMatches = this.renderGroup(searchGroup, this._searchGroupStartLine, searchMatches);

		const result: IFilterResult = {
			allGroups: this.settingsGroups,
			filteredGroups: [searchGroup],
			matches: fixedMatches,
			query: filter
		};
		return result;
	}

	renderFilteredMatches(filteredMatches: IFilterMatch[], filter: string): IFilterResult {
		if (!this._filterGroupStartLine) {
			this._filterGroupStartLine = tail(this.settingsGroups).range.endLineNumber + 2;
		}

		const literalGroup = this.getLiteralResultsGroup(filteredMatches.map(m => m.setting));
		const fixedMatches = this.renderGroup(literalGroup, this._filterGroupStartLine, filteredMatches);

		const result: IFilterResult = {
			allGroups: this.settingsGroups,
			filteredGroups: [literalGroup],
			matches: fixedMatches,
			query: filter
		};
		return result;
	}

	private renderGroup(group: ISettingsGroup, startLine: number, filteredMatches: IFilterMatch[]): IRange[] {
		// this.clearRange(range);

		const builder = new SettingsContentBuilder(startLine - 1);
		builder.pushLine(',');
		builder.pushGroups([group]);
		builder.pushLine('');

		// builder has rewritten settings ranges
		// fix match ranges
		const fixedMatches = flatten(filteredMatches.map(m => m.matches)
			.map((settingMatches, i) => {
				const setting = group.sections[0].settings[i];
				return settingMatches.map(range => {
					// range.startLineNumber += setting.range.startLineNumber;
					return new Range(
						range.startLineNumber + setting.range.startLineNumber,
						range.startColumn,
						range.endLineNumber + setting.range.startLineNumber,
						range.endColumn);
				});
			}));

		// note: 1-indexed line numbers here
		const groupContent = builder.getContent(DefaultSettingsEditorModel.GROUP_SIZE + 1); // + 1 for trailing newline
		const groupEndLine = Math.min(startLine + DefaultSettingsEditorModel.GROUP_SIZE, this._model.getLineCount());
		this._model.applyEdits([
			{
				text: groupContent,
				forceMoveMarkers: false,
				range: new Range(startLine, 1, groupEndLine, 1),
				identifier: { major: 1, minor: 0 }
			}
		]);

		return fixedMatches;
	}

	public findValueMatches(filter: string, setting: ISetting): IRange[] {
		return [];
	}

	public getPreference(key: string): ISetting {
		for (const group of this.settingsGroups) {
			for (const section of group.sections) {
				for (const setting of section.settings) {
					if (setting.key === key) {
						return setting;
					}
				}
			}
		}
		return null;
	}

	private getSettings(rankedSettingNames: (string|ISetting)[]): ISetting[] {
		return rankedSettingNames.map(thing => {
			const setting = typeof thing === 'string' ? this.defaultSettings.getSettingByName(thing) : thing;
			if (setting) {
				return <ISetting>{
					description: setting.description,
					key: setting.key,
					value: setting.value,
					range: null,
					valueRange: null,
					overrides: []
				};
			}
			return null;
		}).filter(setting => !!setting);
	}

	private getLiteralResultsGroup(rankedSettings: ISetting[]): ISettingsGroup {
		return <ISettingsGroup>{
			id: 'literalResults',
			range: null,
			title: nls.localize('literalResults', "Literal Results"),
			titleRange: null,
			sections: [
				{
					settings: this.getSettings(rankedSettings)
				}
			]
		};
	}

	private getSearchResultsGroup(rankedSettings: ISetting[]): ISettingsGroup {
		return <ISettingsGroup>{
			id: 'searchResults',
			range: null,
			title: nls.localize('searchResults', "Search Results"),
			titleRange: null,
			sections: [
				{
					settings: this.getSettings(rankedSettings)
				}
			]
		};
	}
}

class SettingsContentBuilder {
	private _contentByLines: string[];

	get lines(): string[] {
		return this._contentByLines;
	}

	private get lineCountWithOffset(): number {
		return this._contentByLines.length + this._rangeOffset;
	}

	private get lastLine(): string {
		return this._contentByLines[this._contentByLines.length - 1] || '';
	}

	constructor(private _rangeOffset = 0) {
		this._contentByLines = [];
	}

	private offsetIndexToIndex(offsetIdx: number): number {
		return offsetIdx - this._rangeOffset;
	}

	pushLine(...lineText: string[]): void {
		this._contentByLines.push(...lineText);
	}

	pushGroups(settingsGroups: ISettingsGroup[], padTo = 0): void {
		let lastSetting: ISetting = null;
		this._contentByLines.push('{');
		this._contentByLines.push('');
		for (const group of settingsGroups) {
			this._contentByLines.push('');
			lastSetting = this.pushGroup(group);
		}
		if (lastSetting) {
			// Strip the comma from the last setting
			const lineIdx = this.offsetIndexToIndex(lastSetting.range.endLineNumber);
			const content = this._contentByLines[lineIdx - 2];
			this._contentByLines[lineIdx - 2] = content.substring(0, content.length - 1);
		}
		if (padTo) {
			if (this._contentByLines.length < padTo - 1) {
				this._contentByLines.push(...fill(padTo - this._contentByLines.length - 1, () => ''));
			}
		}

		this._contentByLines.push('}');
	}

	private pushGroup(group: ISettingsGroup): ISetting {
		const indent = '  ';
		let lastSetting: ISetting = null;
		let groupStart = this.lineCountWithOffset + 1;
		for (const section of group.sections) {
			if (section.title) {
				let sectionTitleStart = this.lineCountWithOffset + 1;
				this.addDescription([section.title], indent, this._contentByLines);
				section.titleRange = { startLineNumber: sectionTitleStart, startColumn: 1, endLineNumber: this.lineCountWithOffset, endColumn: this.lastLine.length };
			}

			if (section.settings.length) {
				for (const setting of section.settings) {
					this.pushSetting(setting, indent);
					lastSetting = setting;
				}
			}

		}
		group.range = { startLineNumber: groupStart, startColumn: 1, endLineNumber: this.lineCountWithOffset, endColumn: this.lastLine.length };
		return lastSetting;
	}

	getContent(padTo = 0): string {
		if (padTo) {
			if (this._contentByLines.length < padTo - 1) {
				this._contentByLines.push(...fill(padTo - this._contentByLines.length, () => ''));
			}
		}

		return this._contentByLines.join('\n');
	}

	private pushSetting(setting: ISetting, indent: string): void {
		const settingStart = this.lineCountWithOffset + 1;
		setting.descriptionRanges = [];
		const descriptionPreValue = indent + '// ';
		for (const line of setting.description) {
			this._contentByLines.push(descriptionPreValue + line);
			setting.descriptionRanges.push({ startLineNumber: this.lineCountWithOffset, startColumn: this.lastLine.indexOf(line) + 1, endLineNumber: this.lineCountWithOffset, endColumn: this.lastLine.length });
		}

		let preValueConent = indent;
		const keyString = JSON.stringify(setting.key);
		preValueConent += keyString;
		setting.keyRange = { startLineNumber: this.lineCountWithOffset + 1, startColumn: preValueConent.indexOf(setting.key) + 1, endLineNumber: this.lineCountWithOffset + 1, endColumn: setting.key.length };

		preValueConent += ': ';
		const valueStart = this.lineCountWithOffset + 1;
		this.pushValue(setting, preValueConent, indent);

		setting.valueRange = { startLineNumber: valueStart, startColumn: preValueConent.length + 1, endLineNumber: this.lineCountWithOffset, endColumn: this.lastLine.length + 1 };
		this._contentByLines[this._contentByLines.length - 1] += ',';
		this._contentByLines.push('');
		setting.range = { startLineNumber: settingStart, startColumn: 1, endLineNumber: this.lineCountWithOffset, endColumn: this.lastLine.length };
	}

	private pushValue(setting: ISetting, preValueConent: string, indent: string): void {
		let valueString = JSON.stringify(setting.value, null, indent);
		if (valueString && (typeof setting.value === 'object')) {
			if (setting.overrides.length) {
				this._contentByLines.push(preValueConent + ' {');
				for (const subSetting of setting.overrides) {
					this.pushSetting(subSetting, indent + indent);
					this._contentByLines.pop();
				}
				const lastSetting = setting.overrides[setting.overrides.length - 1];
				const content = this._contentByLines[lastSetting.range.endLineNumber - 2];
				this._contentByLines[lastSetting.range.endLineNumber - 2] = content.substring(0, content.length - 1);
				this._contentByLines.push(indent + '}');
			} else {
				const mulitLineValue = valueString.split('\n');
				this._contentByLines.push(preValueConent + mulitLineValue[0]);
				for (let i = 1; i < mulitLineValue.length; i++) {
					this._contentByLines.push(indent + mulitLineValue[i]);
				}
			}
		} else {
			this._contentByLines.push(preValueConent + valueString);
		}
	}

	private addDescription(description: string[], indent: string, result: string[]) {
		for (const line of description) {
			result.push(indent + '// ' + line);
		}
	}
}

export function defaultKeybindingsContents(keybindingService: IKeybindingService): string {
	const defaultsHeader = '// ' + nls.localize('defaultKeybindingsHeader', "Overwrite key bindings by placing them into your key bindings file.");
	return defaultsHeader + '\n' + keybindingService.getDefaultKeybindingsContent();
}

export class DefaultKeybindingsEditorModel implements IKeybindingsEditorModel<any> {

	private _content: string;

	constructor(private _uri: URI,
		@IKeybindingService private keybindingService: IKeybindingService) {
	}

	public get uri(): URI {
		return this._uri;
	}

	public get content(): string {
		if (!this._content) {
			this._content = defaultKeybindingsContents(this.keybindingService);
		}
		return this._content;
	}

	public getPreference(): any {
		return null;
	}

	public dispose(): void {
		// Not disposable
	}
}