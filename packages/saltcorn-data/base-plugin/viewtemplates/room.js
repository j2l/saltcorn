const Field = require("../../models/field");
const Table = require("../../models/table");
const Form = require("../../models/form");
const View = require("../../models/view");
const Workflow = require("../../models/workflow");
const {
  text,
  div,
  h4,
  hr,
  button,
  form,
  input,
  i,
  script,
  domReady,
} = require("@saltcorn/markup/tags");
const { pagination } = require("@saltcorn/markup/helpers");
const { renderForm, tabs, link } = require("@saltcorn/markup");
const { mkTable } = require("@saltcorn/markup");
const {
  link_view,
  stateToQueryString,
  stateFieldsToWhere,
  stateFieldsToQuery,
  readState,
} = require("../../plugin-helper");
const { InvalidConfiguration } = require("../../utils");
const { getState } = require("../../db/state");
const db = require("../../db");

const configuration_workflow = (req) =>
  new Workflow({
    steps: [
      {
        name: req.__("Views"),
        form: async (context) => {
          /*
            we need:
                - message string
                - message show view?
                - message sender field
                - participant field: key to user in table with fkey to this
            */

          const roomtable = await Table.findOne(context.table_id);
          const { child_relations } = await roomtable.get_child_relations();
          //const msg_table_options = child_relations.map(cr=>cr.table.name)
          const participant_field_options = [];
          const msgstring_field_options = [];
          const msgsender_field_options = [];
          for (const { table, key_field } of child_relations) {
            const fields = await table.getFields();
            fields.forEach((f) => {
              if (f.reftable_name === "users") {
                participant_field_options.push(
                  `${table.name}.${key_field.name}.${f.name}`
                );
                msgsender_field_options.push(
                  `${table.name}.${key_field.name}.${f.name}`
                );
              }
              if (f.type && f.type.name === "String") {
                msgstring_field_options.push(
                  `${table.name}.${key_field.name}.${f.name}`
                );
              }
            });
          }
          return new Form({
            fields: [
              {
                name: "msgstring_field",
                label: req.__("Message string field"),
                type: "String",
                sublabel: req.__(
                  "The field for the message content on the table for messages"
                ),
                required: true,
                attributes: {
                  options: msgstring_field_options,
                },
              },
              {
                name: "msgsender_field",
                label: req.__("Message sender field"),
                type: "String",
                sublabel: req.__(
                  "The field for the sender user id on the table for messages"
                ),
                required: true,
                attributes: {
                  options: msgsender_field_options,
                },
              },
              {
                name: "participant_field",
                label: req.__("Participant field"),
                type: "String",
                sublabel: req.__("The field for the participant user id"),
                required: true,
                attributes: {
                  options: participant_field_options,
                },
              },
            ],
          });
        },
      },
    ],
  });

const get_state_fields = () => [
  {
    name: "id",
    type: "Integer",
    required: true,
    primary_key: true,
  },
];

const run = async (
  table_id,
  viewname,
  { participant_field, msgstring_field, msgsender_field },
  state,
  { req, res }
) => {
  const table = await Table.findOne({ id: table_id });
  const fields = await table.getFields();
  readState(state, fields);
  if (!state.id) return "Need room id";

  const appState = getState();
  const locale = req.getLocale();
  const __ = (s) => appState.i18n.__({ phrase: s, locale }) || s;
  if (!participant_field || !msgstring_field || !msgsender_field)
    throw new InvalidConfiguration(
      `View ${viewname} incorrectly configured: must supply Message string, Message sender and Participant fields`
    );

  const [msgtable_name, msgkey_to_room, msgstring] = msgstring_field.split(".");
  const [
    part_table_name,
    part_key_to_room,
    part_user_field,
  ] = participant_field.split(".");
  const [msgtable_name1, msgkey_to_room1, msgsender] = msgsender_field.split(
    "."
  );
  // check we participate
  const parttable = Table.findOne({ name: part_table_name });
  const parttable_fields = await parttable.getFields();
  const parttable_userfield_field = parttable_fields.find(
    (f) => f.name === part_user_field
  );
  const userlabel =
    parttable_userfield_field.attributes.summary_field || "email";
  const participants = await parttable.getJoinedRows({
    where: {
      [part_key_to_room]: state.id,
    },
    joinFields: {
      [userlabel]: { ref: part_user_field, target: userlabel },
    },
  });
  const partRow = participants.find((p) => p[part_user_field] === +req.user.id);
  if (!partRow) return "You are not a participant in this room";

  const msgtable = Table.findOne({ name: msgtable_name });
  const msgs = await msgtable.getRows({ [msgkey_to_room]: state.id });
  // 2. insert message form
  return div(
    div(
      { class: `msglist-${state.id}` },
      msgs.map(
        showMsg(
          msgstring,
          req,
          msgsender,
          userlabel,
          participants,
          part_user_field
        )
      )
    ),
    form(
      { class: `room-${state.id}`, action: "" },
      input({ autocomplete: "off", name: "message" }),
      button(i({ class: "far fa-paper-plane" }))
    ),
    script({
      src: `/static_assets/${db.connectObj.version_tag}/socket.io.min.js`,
    }) + script(domReady(`init_room("${viewname}", ${state.id})`))
  );
};

const showMsg = (
  msgstring,
  req,
  msgsender,
  userlabel,
  participants,
  part_user_field
) => (msg) => {
  if (participants && msgsender && part_user_field) {
    const participant = participants.find(
      (p) => p[part_user_field] === msg[msgsender]
    );
    return div(
      participant ? participant[userlabel] : "?",
      ": ",
      msg[msgstring]
    );
  } else {
    return div(req.user[userlabel], ": ", msg[msgstring]);
  }
};

const submit_msg_ajax = async (
  table_id,
  viewname,
  { participant_field, msgstring_field, msgsender_field },
  body,
  { req, res }
) => {
  const [msgtable_name, msgkey_to_room, msgstring] = msgstring_field.split(".");
  const [msgtable_name1, msgkey_to_room1, msgsender] = msgsender_field.split(
    "."
  );
  const msgtable = Table.findOne({ name: msgtable_name });

  const [
    part_table_name,
    part_key_to_room,
    part_user_field,
  ] = participant_field.split(".");

  // TODO check we participate
  const parttable = Table.findOne({ name: part_table_name });
  const parttable_fields = await parttable.getFields();
  const parttable_userfield_field = parttable_fields.find(
    (f) => f.name === part_user_field
  );
  const userlabel =
    parttable_userfield_field.attributes.summary_field || "email";
  const row = {
    [msgstring]: body.message,
    [msgkey_to_room]: body.room_id,
    [msgsender]: req.user.id,
  };
  await msgtable.tryInsertRow(row, req.user.id);
  const html = showMsg(msgstring, req, null, userlabel)(row);
  getState().emitRoom(+body.room_id, html);
  return {
    json: {
      success: "ok",
    },
  };
};
module.exports = {
  name: "Room",
  description: "Real-time space for chat",
  configuration_workflow,
  run,
  get_state_fields,
  display_state_form: false,
  routes: { submit_msg_ajax },

  getStringsForI18n({ create_view_label }) {
    if (create_view_label) return [create_view_label];
    else return [];
  },
};
/*todo:

1. test on multiple browser windows
2. auth
3. multiple workers
4. https and greenlocks

*/
