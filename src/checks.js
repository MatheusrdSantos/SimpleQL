/** This file contains functions to check the validity of the parameters provided to simple-ql */
const check = require('./utils/type-checking');
const { dbColumn, database } = require('./utils/types');
const { stringify, classifyData, reservedKeys } = require('./utils');

/** Check that the tables that are going to be created are valid */
function checkTables(tables) {
  const acceptedTypes = ['string', 'integer', 'float', 'double', 'decimal', 'date', 'dateTime', 'boolean', 'text', 'binary'];
  //check values
  return Promise.all(Object.keys(tables).map(tableName => {
    const table = tables[tableName];
    return Promise.all(reservedKeys.map(field => (field!=='index' && table[field]) ? Promise.reject(`${field} is a reserved field`) : Promise.resolve()))
      .then(() => Promise.all(Object.keys(table).map(field => checkField(tableName, field, table[field]))));
  }));

  /** Check that the field value is valid */
  function checkField(tableName, field, value) {
    if(field==='index') {
      if(!(value instanceof Array) && !(Object(value) instanceof String)) return Promise.reject(`Field 'index' in ${tableName} must be an array containing objects where keys are 'column', 'type' and 'length', or a string separing these values with a '/'.`);
      return Promise.resolve();
    }
    if(Object.keys(tables).includes(field)) return Promise.reject(`Field ${field} in ${tableName} cannot have the same name as a table.`);
    if(Object(value) instanceof String) {
      const [type, size] = value.split('/');
      if(!acceptedTypes.includes(type)) return Promise.reject(`${value} is invalid value for ${field} in ${tableName}. Valid types are: ${acceptedTypes.join(', ')}`);
      if(!size) return Promise.resolve();
      //We check for each type that the size property is valid
      switch(type) {
        case 'boolean':
        case 'integer':
        case 'string':
        case 'binary':
        case 'text': {
          if(parseInt(size,10)!=size) return Promise.reject(`${field} in ${tableName} expected an integer after the / but we reveived ${size}`);
          break;
        }
        case 'double':
        case 'decimal':
        case 'float': {
          const [s,d] = size.split(',');
          if(!d || parseInt(s,10)!=s || parseInt(d,10)!=d) return Promise.reject(`${field} in ${tableName} expected a decimal parameter like 8,2 but we reveived ${size}`);
          break;
        }
        default:
          return Promise.reject(`${field} in ${tableName} received the parameter ${size} but we didn't expect one.`); 
      }
    } else if(value instanceof Array) {
      if(value.length!==1) return Promise.reject(`${field} in ${tableName} is an array and should contain only one element which whould be pointing to another table`);
      //We now check that the table object is correctly defined and reference another table
      return checkField(tableName, `${field}[]`, value[0]);
    } else if(value instanceof Object) {
      //reference to another table
      if(Object.values(tables).includes(value)) return Promise.resolve();
      //a descriptive object describing the column properties
      try {
        check(dbColumn, value);
      } catch(err) {
        return Promise.reject(`${field} in ${tableName} received an invalid object. It should be a string, an array, a descriptive object containing a 'type' property', or one of the tables. ${err}`);
      }
      return checkField(tableName, field, value.type);
    } else if(value === undefined) {
      return Promise.reject(`${field} has undefined value in ${tableName}. It should be a string, an array or an object. If you tried to make a self reference or a cross reference between tables, see the documentation.`);
    } else {
      return Promise.reject(`${value} is an invalid value for ${field} in ${tableName}. It should be a string, an array or an object`);
    }
    return Promise.resolve();
  }
}

/** Check that the database information are valid */
function checkDatabase(data) {
  try {
    check(database, data);
  } catch(err) {
    throw `The database object provided is incorrect. ${err}`;
  }
}

/** Check that the rules are valid */
function checkRules(rules, tables) {
  function checkRule(value, possibleValues, ruleName) {
    try {
      return check(possibleValues.reduce((model, key) => ({...model, [key] : 'function'}), {strict: true}), value);
    } catch(err) {
      throw new Error(`We expect rule ${ruleName} to receive function parameters for keys ${JSON.stringify(possibleValues)}, but we received ${stringify(value)}`);
    }
  }
  return Promise.all(Object.keys(rules).map(key => {
    const table = tables[key];
    if(!table) return Promise.reject(`You defined a rule for table ${key} which is not defined.`);
    const { primitives, objects, arrays } = classifyData(table);
    const rule = rules[key];
    
    return Promise.all(Object.keys(rule).map(ruleName => {
      const value = rule[ruleName];
      if(table[ruleName]) {
        if(primitives.includes(ruleName)) return checkRule(value, ['read', 'write'], ruleName);
        if(objects.includes(ruleName)) return checkRule(value, ['read', 'write'], ruleName);
        if(arrays.includes(ruleName)) return checkRule(value, ['add', 'remove'], ruleName);
        return Promise.reject(`This should not be possible. The issue occured with the rule ${ruleName} for table ${key}.`);
      } else {
        const instructions = ['read', 'write', 'create', 'delete'];
        if(!instructions.includes(ruleName)) return Promise.reject(`You defined a rule for ${ruleName} which is not defined in the table ${key}`);
        if(value instanceof Function) return Promise.resolve();
        return Promise.reject(`The rule ${ruleName} for table ${key} has to be a function.`);
      }
    }));
  }))
    
    //Make sure that all tables have access rules
    .then(() => Promise.all(Object.keys(tables).map(
      table => rules[table] || Promise.reject(`You need to provide access rules for table ${table}. Please see "Control Access" section in the documentation.`)
    )));
}

/** Check that all provided plugins are well formed. */
function checkPlugins(plugins, tables) {
  const pluginKeys = ['middleware', 'onRequest', 'onCreation', 'onDeletion', 'onResult', 'preRequisite', 'errorHandler'];
  if(!(plugins instanceof Array)) return Promise.reject(`plugins should be an array. But we received ${JSON.stringify(plugins)}.`);
  return Promise.all(plugins.map(plugin => {
    return Promise.all(Object.keys(plugin).map(key => {
      if(!pluginKeys.includes(key)) return Promise.reject(`Plugins can only contain these functions: ${pluginKeys}, but we found ${key}.`);
      if(key === 'middleware') {
        if(!(plugin[key] instanceof Function)) return Promise.reject(`${key} should be a function in your plugin. But we received ${JSON.stringify(plugin[key])}.`);
      } else {
        //case preprocessing and postprocessing
        if(!(plugin[key] instanceof Object)) return Promise.reject(`${key} should be an object in your plugin. But we received ${JSON.stringify(plugin[key])}.`);
        return Promise.all(Object.keys(plugin[key]).map(table => {
          if(!Object.keys(tables).includes(table)) return Promise.reject(`${table} is not one of the defined tables. ${key} should only contains existing tables as keys.`);
          if(!(plugin[key][table] instanceof Function)) return Promise.reject(`${table} is not a function. ${key} should only contains functions as values.`);
        }));
      }
    }));
  }));
}

module.exports = ({tables, database, rules, plugins}) => {
  return checkTables(tables)
    .then(() => checkDatabase(database))
    .then(() => checkRules(rules, tables))
    .then(() => checkPlugins(plugins, tables));
};