/** Types derived from the vendored Atlassian schemas. DO NOT EDIT — regenerate with
 * `deno task types`; `deno task check` fails if this file has drifted.
 *
 * Jira Cloud platform REST API: 1001.0.0-SNAPSHOT-82b018affa468e58f284fbe4df33536469d757df
 * Atlassian Document Format:   57.3.4
 *
 * Both specs are Apache-2.0; see spec/NOTICE. What the specs cannot express stays
 * hand-written in ./types.ts — most importantly `JiraIssueFields`, because the platform
 * spec models an issue's `fields` as an untyped bag.
 */

// ---------------------------------------------------------------------------
// Atlassian Document Format
// ---------------------------------------------------------------------------

/** Every node kind the ADF schema declares (43). */
export type AdfNodeType =
  | 'blockCard'
  | 'blockquote'
  | 'blockTaskItem'
  | 'bodiedExtension'
  | 'bodiedSyncBlock'
  | 'bulletList'
  | 'caption'
  | 'codeBlock'
  | 'date'
  | 'decisionItem'
  | 'decisionList'
  | 'doc'
  | 'embedCard'
  | 'emoji'
  | 'expand'
  | 'extension'
  | 'hardBreak'
  | 'heading'
  | 'inlineCard'
  | 'inlineExtension'
  | 'layoutColumn'
  | 'layoutSection'
  | 'listItem'
  | 'media'
  | 'mediaGroup'
  | 'mediaInline'
  | 'mediaSingle'
  | 'mention'
  | 'nestedExpand'
  | 'orderedList'
  | 'panel'
  | 'paragraph'
  | 'placeholder'
  | 'rule'
  | 'status'
  | 'syncBlock'
  | 'table'
  | 'tableCell'
  | 'tableHeader'
  | 'tableRow'
  | 'taskItem'
  | 'taskList'
  | 'text';

/** Every mark kind the ADF schema declares (17). */
export type AdfMarkType =
  | 'alignment'
  | 'annotation'
  | 'backgroundColor'
  | 'border'
  | 'breakout'
  | 'code'
  | 'dataConsumer'
  | 'em'
  | 'fontSize'
  | 'fragment'
  | 'indentation'
  | 'link'
  | 'strike'
  | 'strong'
  | 'subsup'
  | 'textColor'
  | 'underline';

/** The `attrs` each node kind carries, for the kinds that declare any. This is what the
 * hand-written `Record<string, unknown>` could not say: `panel` has a closed set of
 * `panelType`s, `status` requires a `text` and a `color`, and so on. */
export type AdfAttrs = {
  blockCard: {
    localId?: string;
    url?: string;
    datasource: {
      id: string;
      parameters: unknown;
      views: Array<{
        properties?: unknown;
        type: string;
      }>;
    };
    width?: number;
    layout?:
      | 'wide'
      | 'full-width'
      | 'center'
      | 'wrap-right'
      | 'wrap-left'
      | 'align-end'
      | 'align-start';
  } | {
    url: string;
    localId?: string;
  } | {
    data: unknown;
    localId?: string;
  };
  blockquote: {
    localId?: string;
  };
  blockTaskItem: {
    localId: string;
    state: 'TODO' | 'DONE';
  };
  bodiedExtension: {
    extensionKey: string;
    extensionType: string;
    parameters?: unknown;
    text?: string;
    layout?: 'wide' | 'full-width' | 'default';
    localId?: string;
  };
  bodiedSyncBlock: {
    resourceId: string;
    localId: string;
  };
  bulletList: {
    localId?: string;
  };
  caption: {
    localId?: string;
  };
  codeBlock: {
    language?: string;
    uniqueId?: string;
    localId?: string;
    wrap?: boolean;
    hideLineNumbers?: boolean;
  };
  date: {
    timestamp: string;
    localId?: string;
  };
  decisionItem: {
    localId: string;
    state: string;
  };
  decisionList: {
    localId: string;
  };
  embedCard: {
    url: string;
    layout:
      | 'wide'
      | 'full-width'
      | 'center'
      | 'wrap-right'
      | 'wrap-left'
      | 'align-end'
      | 'align-start';
    width?: number;
    originalHeight?: number;
    originalWidth?: number;
    localId?: string;
  };
  emoji: {
    shortName: string;
    id?: string;
    text?: string;
    localId?: string;
  };
  expand: {
    title?: string;
    localId?: string;
  };
  extension: {
    extensionKey: string;
    extensionType: string;
    parameters?: unknown;
    text?: string;
    layout?: 'wide' | 'full-width' | 'default';
    localId?: string;
  };
  hardBreak: {
    text?: '\n';
    localId?: string;
  };
  heading: {
    level: number;
    localId?: string;
  };
  inlineCard: {
    url: string;
    localId?: string;
  } | {
    data: unknown;
    localId?: string;
  };
  inlineExtension: {
    extensionKey: string;
    extensionType: string;
    parameters?: unknown;
    text?: string;
    localId?: string;
  };
  layoutColumn: {
    width: number;
    localId?: string;
    valign?: 'top' | 'middle' | 'bottom';
  };
  layoutSection: {
    localId?: string;
  };
  listItem: {
    localId?: string;
  };
  media: {
    type: 'link' | 'file';
    localId?: string;
    id: string;
    alt?: string;
    collection: string;
    height?: number;
    occurrenceKey?: string;
    width?: number;
  } | {
    type: 'external';
    localId?: string;
    alt?: string;
    height?: number;
    width?: number;
    url: string;
  };
  mediaInline: {
    type?: 'link' | 'file' | 'image';
    localId?: string;
    id: string;
    alt?: string;
    collection: string;
    occurrenceKey?: string;
    width?: number;
    height?: number;
    data?: unknown;
  };
  mediaSingle: {
    localId?: string;
    width?: number;
    layout:
      | 'wide'
      | 'full-width'
      | 'center'
      | 'wrap-right'
      | 'wrap-left'
      | 'align-end'
      | 'align-start';
    widthType?: 'percentage';
  } | {
    localId?: string;
    width: number;
    widthType: 'pixel';
    layout:
      | 'wide'
      | 'full-width'
      | 'center'
      | 'wrap-right'
      | 'wrap-left'
      | 'align-end'
      | 'align-start';
  };
  mention: {
    id: string;
    localId?: string;
    text?: string;
    accessLevel?: string;
    userType?: 'DEFAULT' | 'SPECIAL' | 'APP';
  };
  nestedExpand: {
    title?: string;
    localId?: string;
  };
  orderedList: {
    order?: number;
    localId?: string;
  };
  panel: {
    panelType: 'info' | 'note' | 'tip' | 'warning' | 'error' | 'success' | 'custom';
    panelIcon?: string;
    panelIconId?: string;
    panelIconText?: string;
    panelColor?: string;
    localId?: string;
  };
  paragraph: {
    localId?: string;
  };
  placeholder: {
    text: string;
    localId?: string;
  };
  rule: {
    localId?: string;
  };
  status: {
    text: string;
    color: 'neutral' | 'purple' | 'blue' | 'red' | 'yellow' | 'green';
    localId?: string;
    style?: string;
  };
  syncBlock: {
    resourceId: string;
    localId: string;
  };
  table: {
    displayMode?: 'default' | 'fixed';
    isNumberColumnEnabled?: boolean;
    layout?: 'wide' | 'full-width' | 'center' | 'align-end' | 'align-start' | 'default';
    localId?: string;
    width?: number;
  };
  tableCell: {
    colspan?: number;
    rowspan?: number;
    colwidth?: number[];
    background?: string;
    localId?: string;
    valign?: 'top' | 'middle' | 'bottom';
  };
  tableHeader: {
    colspan?: number;
    rowspan?: number;
    colwidth?: number[];
    background?: string;
    localId?: string;
    valign?: 'top' | 'middle' | 'bottom';
  };
  tableRow: {
    localId?: string;
  };
  taskItem: {
    localId: string;
    state: 'TODO' | 'DONE';
  };
  taskList: {
    localId: string;
  };
};

/** A node in an ADF tree.
 *
 * Deliberately **open**: `type` admits any string, not just `AdfNodeType`. Jira Cloud ships
 * node kinds ahead of this schema, and src/adf/to_markdown.ts is built to fall through an
 * unrecognised node into its `content` rather than lose the document. Narrowing this to a
 * closed union would turn a graceful degradation into a compile error, and eventually into
 * dropped content. `AdfNodeType` is still exported, so a `switch` gets autocomplete and an
 * explicit list of what the schema knows about. */
export type AdfNode = {
  type: AdfNodeType | (string & Record<never, never>);
  version?: number;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
};

/** A mark on an ADF node. Open for the same reason as `AdfNode`. */
export type AdfMark = {
  type: AdfMarkType | (string & Record<never, never>);
  attrs?: Record<string, unknown>;
};

/** The attrs a given node kind declares, or `Record<string, unknown>` for kinds the schema
 * gives no attrs. Lets a converter branch read `attrs` with real types:
 * `(node.attrs as AttrsOf<'panel'>).panelType`. */
export type AttrsOf<K extends AdfNodeType> = K extends keyof AdfAttrs ? AdfAttrs[K]
  : Record<string, unknown>;

// ---------------------------------------------------------------------------
// Jira Cloud platform REST API
// ---------------------------------------------------------------------------

/** Details about an attachment. */
export type JiraAttachment = {
  /** Details of the user who added the attachment. */
  author?: JiraUser | null;
  /** The content of the attachment. */
  content: string;
  /** The datetime the attachment was created. */
  created?: string;
  /** The file name of the attachment. */
  filename: string;
  /** The ID of the attachment. */
  id: string;
  /** The MIME type of the attachment. */
  mimeType?: string;
  /** The URL of the attachment details response. */
  self?: string;
  /** The size of the attachment. */
  size?: number;
  /** The URL of a thumbnail representing the attachment. */
  thumbnail?: string;
};

export type AvatarUrlsBean = {
  /** The URL of the item's 16x16 pixel avatar. */
  '16x16'?: string;
  /** The URL of the item's 24x24 pixel avatar. */
  '24x24'?: string;
  /** The URL of the item's 32x32 pixel avatar. */
  '32x32'?: string;
  /** The URL of the item's 48x48 pixel avatar. */
  '48x48'?: string;
};

/** A change item. */
export type ChangeDetails = {
  /** The name of the field changed. */
  field?: string;
  /** The ID of the field changed. */
  fieldId?: string;
  /** The type of the field changed. */
  fieldtype?: string;
  /** The details of the original value. */
  from?: string;
  /** The details of the original value as a string. */
  fromString?: string;
  /** The details of the new value. */
  to?: string;
  /** The details of the new value as a string. */
  toString?: string;
};

/**
 * A log of changes made to issue fields. Changelogs related to workflow associations are currently
 * being deprecated.
 */
export type Changelog = {
  /** The user who made the change. */
  author?: JiraUser;
  /** The date on which the change took place. */
  created?: string;
  /** The history metadata associated with the changed. */
  historyMetadata?: HistoryMetadata;
  /** The ID of the changelog. */
  id?: string;
  /** The list of items changed. */
  items?: ChangeDetails[];
};

/** A comment. */
export type JiraComment = {
  /** The ID of the user who created the comment. */
  author?: JiraUser | null;
  /**
   * The comment text in [Atlassian Document
   * Format](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/).
   */
  body?: AdfNode;
  /** The date and time at which the comment was created. */
  created?: string;
  /** The ID of the comment. */
  id: string;
  /**
   * Whether the comment was added from an email sent by a person who is not part of the issue. See
   * [Allow external emails to be added as comments on
   * issues](https://support.atlassian.com/jira-service-management-cloud/docs/allow-external-emails-to-be-added-as-comments-on-issues/)for
   * information on setting up this feature.
   */
  jsdAuthorCanSeeRequest?: boolean;
  /**
   * Whether the comment is visible in Jira Service Desk. Defaults to true when comments are
   * created in the Jira Cloud Platform. This includes when the site doesn't use Jira Service Desk
   * or the project isn't a Jira Service Desk project and, therefore, there is no Jira Service Desk
   * for the issue to be visible on. To create a comment with its visibility in Jira Service Desk
   * set to false, use the Jira Service Desk REST API [Create request
   * comment](https://developer.atlassian.com/cloud/jira/service-desk/rest/#api-rest-servicedeskapi-request-issueIdOrKey-comment-post)
   * operation.
   */
  jsdPublic?: boolean;
  /** A list of comment properties. Optional on create and update. */
  properties?: EntityProperty[];
  /** The rendered version of the comment. */
  renderedBody?: string;
  /** The URL of the comment. */
  self?: string;
  /** The ID of the user who updated the comment last. */
  updateAuthor?: JiraUser | null;
  /** The date and time at which the comment was updated last. */
  updated?: string;
  /** The group or role to which this comment is visible. Optional on create and update. */
  visibility?: Visibility;
};

/**
 * An entity property, for more information see [Entity
 * properties](https://developer.atlassian.com/cloud/jira/platform/jira-entity-properties/).
 */
export type EntityProperty = {
  /** The key of the property. Required on create and update. */
  key?: string;
  /** The value of the property. Required on create and update. */
  value?: unknown;
};

/** Details about a field. */
export type JiraFieldMeta = {
  /**
   * The names that can be used to reference the field in an advanced search. For more information,
   * see [Advanced searching - fields reference](https://confluence.atlassian.com/x/gwORLQ).
   */
  clauseNames?: string[];
  /** Whether the field is a custom field. */
  custom: boolean;
  /** The ID of the field. */
  id: string;
  /** The key of the field. */
  key?: string;
  /** The name of the field. */
  name: string;
  /** Whether the field can be used as a column on the issue navigator. */
  navigable?: boolean;
  /** Whether the content of the field can be used to order lists. */
  orderable?: boolean;
  /** The data schema for the field. */
  schema?: JsonTypeBean;
  /** The scope of the field. */
  scope?: Scope;
  /** Whether the content of the field can be searched. */
  searchable?: boolean;
};

/** The metadata describing an issue field. */
export type FieldMetadata = {
  /** The list of values allowed in the field. */
  allowedValues?: unknown[];
  /** The URL that can be used to automatically complete the field. */
  autoCompleteUrl?: string;
  /** The configuration properties. */
  configuration?: Record<string, unknown>;
  /** The default value of the field. */
  defaultValue?: unknown;
  /** Whether the field has a default value. */
  hasDefaultValue?: boolean;
  /** The key of the field. */
  key: string;
  /** The name of the field. */
  name: string;
  /** The list of operations that can be performed on the field. */
  operations: string[];
  /** Whether the field is required. */
  required: boolean;
  /** The data type of the field. */
  schema: JsonTypeBean;
};

/** Details of issue history metadata. */
export type HistoryMetadata = {
  /** The activity described in the history record. */
  activityDescription?: string;
  /** The key of the activity described in the history record. */
  activityDescriptionKey?: string;
  /** Details of the user whose action created the history record. */
  actor?: HistoryMetadataParticipant;
  /** Details of the cause that triggered the creation the history record. */
  cause?: HistoryMetadataParticipant;
  /** The description of the history record. */
  description?: string;
  /** The description key of the history record. */
  descriptionKey?: string;
  /** The description of the email address associated the history record. */
  emailDescription?: string;
  /** The description key of the email address associated the history record. */
  emailDescriptionKey?: string;
  /** Additional arbitrary information about the history record. */
  extraData?: Record<string, string>;
  /** Details of the system that generated the history record. */
  generator?: HistoryMetadataParticipant;
  /** The type of the history record. */
  type?: string;
};

/** Details of user or system associated with a issue history metadata item. */
export type HistoryMetadataParticipant = {
  /** The URL to an avatar for the user or system associated with a history record. */
  avatarUrl?: string;
  /** The display name of the user or system associated with a history record. */
  displayName?: string;
  /** The key of the display name of the user or system associated with a history record. */
  displayNameKey?: string;
  /** The ID of the user or system associated with a history record. */
  id?: string;
  /** The type of the user or system associated with a history record. */
  type?: string;
  /** The URL of the user or system associated with a history record. */
  url?: string;
};

export type IncludedFields = {
  actuallyIncluded?: string[];
  excluded?: string[];
  included?: string[];
};

/** Details about an issue. */
export type JiraIssueBean = {
  /** Details of changelogs associated with the issue. */
  changelog?: PageOfChangelogs;
  /** The metadata for the fields on the issue that can be amended. */
  editmeta?: IssueUpdateMetadata;
  /** Expand options that include additional issue details in the response. */
  expand?: string;
  fields: Record<string, unknown>;
  fieldsToInclude?: IncludedFields;
  /** The ID of the issue. */
  id: string;
  /** The key of the issue. */
  key: string;
  /** The ID and name of each field present on the issue. */
  names?: Record<string, string>;
  /** The operations that can be performed on the issue. */
  operations?: Operations;
  /** Details of the issue properties identified in the request. */
  properties?: Record<string, unknown>;
  /** The rendered value of each field present on the issue. */
  renderedFields?: Record<string, unknown>;
  /** The schema describing each field present on the issue. */
  schema?: Record<string, JsonTypeBean>;
  /** The URL of the issue details. */
  self?: string;
  /** The transitions that can be performed on the issue. */
  transitions?: IssueTransition[];
  /** The versions of each field on the issue. */
  versionedRepresentations?: Record<string, Record<string, unknown>>;
};

/** Details of an issue transition. */
export type IssueTransition = {
  /** Expand options that include additional transition details in the response. */
  expand?: string;
  /**
   * Details of the fields associated with the issue transition screen. Use this information to
   * populate `fields` and `update` in a transition request.
   */
  fields?: Record<string, FieldMetadata>;
  /** Whether there is a screen associated with the issue transition. */
  hasScreen?: boolean;
  /** The ID of the issue transition. Required when specifying a transition to undertake. */
  id?: string;
  /** Whether the transition is available to be performed. */
  isAvailable?: boolean;
  /** Whether the issue has to meet criteria before the issue transition is applied. */
  isConditional?: boolean;
  /**
   * Whether the issue transition is global, that is, the transition is applied to issues
   * regardless of their status.
   */
  isGlobal?: boolean;
  /** Whether this is the initial issue transition for the workflow. */
  isInitial?: boolean;
  looped?: boolean;
  /** The name of the issue transition. */
  name?: string;
  /** Details of the issue status after the transition. */
  to?: StatusDetails;
};

/** A list of editable field details. */
export type IssueUpdateMetadata = {
  fields?: Record<string, FieldMetadata>;
};

/** The schema of a field. */
export type JsonTypeBean = {
  /** If the field is a custom field, the configuration of the field. */
  configuration?: Record<string, unknown>;
  /** If the field is a custom field, the URI of the field. */
  custom?: string;
  /** If the field is a custom field, the custom ID of the field. */
  customId?: number;
  /** When the data type is an array, the name of the field items within the array. */
  items?: string;
  /** If the field is a system field, the name of the field. */
  system?: string;
  /** The data type of the field. */
  type: string;
};

/** Details a link group, which defines issue operations. */
export type LinkGroup = {
  groups?: LinkGroup[];
  header?: SimpleLink;
  id?: string;
  links?: SimpleLink[];
  styleClass?: string;
  weight?: number;
};

/** Details of the operations that can be performed on the issue. */
export type Operations = {
  /** Details of the link groups defining issue operations. */
  linkGroups?: LinkGroup[];
};

/** A page of changelogs. */
export type PageOfChangelogs = {
  /** The list of changelogs. */
  histories?: Changelog[];
  /** The maximum number of results that could be on the page. */
  maxResults?: number;
  /** The index of the first item returned on the page. */
  startAt?: number;
  /** The number of results on the page. */
  total?: number;
};

/** A page of comments. */
export type JiraCommentPage = {
  /** The list of comments. */
  comments?: JiraComment[];
  /** The maximum number of items that could be returned. */
  maxResults?: number;
  /** The index of the first item returned. */
  startAt?: number;
  /** The number of items returned. */
  total?: number;
};

/** Details about a project. */
export type ProjectDetails = {
  /** The URLs of the project's avatars. */
  avatarUrls?: AvatarUrlsBean;
  /** The ID of the project. */
  id?: string;
  /** The key of the project. */
  key?: string;
  /** The name of the project. */
  name?: string;
  /** The category the project belongs to. */
  projectCategory?: UpdatedProjectCategory;
  /**
   * The [project
   * type](https://confluence.atlassian.com/x/GwiiLQ#Jiraapplicationsoverview-Productfeaturesandprojecttypes)
   * of the project.
   */
  projectTypeKey?: 'software' | 'service_desk' | 'business' | 'product_discovery';
  /** The URL of the project details. */
  self?: string;
  /** Whether or not the project is simplified. */
  simplified?: boolean;
};

/**
 * The projects the item is associated with. Indicated for items associated with [next-gen
 * projects](https://confluence.atlassian.com/x/loMyO).
 */
export type Scope = {
  /** The project the item has scope in. */
  project?: ProjectDetails;
  /** The type of scope. */
  type?: 'PROJECT' | 'TEMPLATE';
};

/** The result of a JQL search with issues reconsilation. */
export type JiraSearchPage = {
  /** Indicates whether this is the last page of the paginated response. */
  isLast?: boolean;
  /** The list of issues found by the search or reconsiliation. */
  issues?: JiraIssueBean[];
  /** The ID and name of each field in the search results. */
  names?: Record<string, string>;
  /**
   * Continuation token to fetch the next page. If this result represents the last or the only page
   * this token will be null. This token will expire in 7 days.
   */
  nextPageToken?: string;
  /** The schema describing the field types in the search results. */
  schema?: Record<string, JsonTypeBean>;
  /**
   * Experimental. Warnings generated during the search, e.g. when a JQL clause exceeded its
   * argument limit or when the result set was truncated due to an ingestion limit. This field is
   * currently rolling out behind a feature flag and may be absent, empty, or change shape without
   * notice until generally available.
   */
  warnings?: SearchWarning[];
};

/** Experimental. A warning returned alongside successful search results. */
export type SearchWarning = {
  /** Structured details about the warning, if available. */
  details?: SearchWarningLimitDetails;
  /** A human-readable explanation of the warning suitable for surfacing to end users. */
  message?: string;
  /** The type of warning, e.g. CLAUSE\_LIMIT\_EXCEEDED. */
  type?: string;
};

/** Experimental. Structured details about a JQL clause exceeding its argument limit. */
export type SearchWarningLimitDetails = {
  /** The actual number of arguments supplied that exceeded the limit. */
  actual?: number;
  /** The arguments passed to the JQL clause. */
  arguments?: string;
  /** The JQL clause that triggered the limit, e.g. issueHistory(). */
  clause?: string;
  /** The maximum number of arguments allowed for the clause. */
  limit?: number;
};

/** Details about the operations available in this version. */
export type SimpleLink = {
  href?: string;
  iconClass?: string;
  id?: string;
  label?: string;
  styleClass?: string;
  title?: string;
  weight?: number;
};

/** A status category. */
export type StatusCategory = {
  /** The name of the color used to represent the status category. */
  colorName?: string;
  /** The ID of the status category. */
  id?: number;
  /** The key of the status category. */
  key?: string;
  /** The name of the status category. */
  name?: string;
  /** The URL of the status category. */
  self?: string;
};

/** A status. */
export type StatusDetails = {
  /** The description of the status. */
  description?: string;
  /** The URL of the icon used to represent the status. */
  iconUrl?: string;
  /** The ID of the status. */
  id?: string;
  /** The name of the status. */
  name?: string;
  /** The scope of the field. */
  scope?: Scope;
  /** The URL of the status. */
  self?: string;
  /** The category assigned to the status. */
  statusCategory?: StatusCategory;
};

/** A project category. */
export type UpdatedProjectCategory = {
  /** The name of the project category. */
  description?: string;
  /** The ID of the project category. */
  id?: string;
  /** The description of the project category. */
  name?: string;
  /** The URL of the project category. */
  self?: string;
};

/**
 * User details permitted by the user's Atlassian Account privacy settings. However, be aware of
 * these exceptions: * User record deleted from Atlassian: This occurs as the result of a right to
 * be forgotten request. In this case, `displayName` provides an indication and other parameters
 * have default values or are blank (for example, email is blank). * User record corrupted: This
 * occurs as a results of events such as a server import and can only happen to deleted users. In
 * this case, `accountId` returns *unknown* and all other parameters have fallback values. * User
 * record unavailable: This usually occurs due to an internal service outage. In this case, all
 * parameters have fallback values.
 */
export type JiraUser = {
  /**
   * The account ID of the user, which uniquely identifies the user across all Atlassian products.
   * For example, *5b10ac8d82e05b22cc7d4ef5*.
   */
  accountId?: string;
  /**
   * The type of account represented by this user. This will be one of 'atlassian' (normal users),
   * 'app' (application user) or 'customer' (Jira Service Desk customer user)
   */
  accountType?: string;
  /** Whether the user is active. */
  active?: boolean;
  /** The avatars of the user. */
  avatarUrls?: AvatarUrlsBean;
  /**
   * The display name of the user. Depending on the user’s privacy settings, this may return an
   * alternative value.
   */
  displayName?: string;
  /**
   * The email address of the user. Depending on the user’s privacy settings, this may be returned
   * as null.
   */
  emailAddress?: string;
  /**
   * This property is no longer available and will be removed from the documentation soon. See the
   * [deprecation
   * notice](https://developer.atlassian.com/cloud/jira/platform/deprecation-notice-user-privacy-api-migration-guide/)
   * for details.
   */
  key?: string;
  /**
   * This property is no longer available and will be removed from the documentation soon. See the
   * [deprecation
   * notice](https://developer.atlassian.com/cloud/jira/platform/deprecation-notice-user-privacy-api-migration-guide/)
   * for details.
   */
  name?: string;
  /** The URL of the user. */
  self?: string;
  /**
   * The time zone specified in the user's profile. Depending on the user’s privacy settings, this
   * may be returned as null.
   */
  timeZone?: string;
};

/** The group or role to which this item is visible. */
export type Visibility = {
  /** The ID of the group or the name of the role that visibility of this item is restricted to. */
  identifier?: string | null;
  /** Whether visibility of this item is restricted to a group or role. */
  type?: 'group' | 'role';
  /**
   * The name of the group or role that visibility of this item is restricted to. Please note that
   * the name of a group is mutable, to reliably identify a group use `identifier`.
   */
  value?: string;
};
