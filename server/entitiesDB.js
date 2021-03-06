//------------------------------------------------------------------------------
// Copyright IBM Corp. 2015
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//------------------------------------------------------------------------------

var Promise = require('bluebird');
var mongoose = require('mongoose');
var String = mongoose.Schema.Types.String;
var Number = mongoose.Schema.Types.Number;
var moment = require('moment');

// define schemas and models for articles
var articleSchema = new mongoose.Schema({
  _id: String,
  title: String,
  date: mongoose.Schema.Types.Date,
  url: String
});
var Article = mongoose.model('Article', articleSchema);

// define schemas and models for entities
var entitySchema = new mongoose.Schema({
  _id: String,
  text: String,
  count: Number,
  sentiment: Number,
  date: Date,
  article_id: String
});
var Entity = mongoose.model('Entity', entitySchema);

// DB object with fun methods
var EntitiesDB = {
  /**
   * Initialize the database connection
   */
  init: function () {
    // step one: load the credentials from either json or env variable
    var userProvided;
    if (process.env.VCAP_SERVICES) {
      userProvided = JSON.parse(process.env.VCAP_SERVICES)['user-provided'];
    } else {
      try {
        var config = require('./config.json');
        userProvided = config['user-provided'];
      } catch (e) { console.error(e); }
    }
    // step one part two: extract the uri from the userProvided object
    var mongoURI;
    for (var i = 0; i < userProvided.length; i++) {
      if (userProvided[i].name.indexOf('mongolab') > -1) {
        mongoURI = userProvided[i].credentials.uri;
      }
    }
    mongoose.connect(mongoURI);
    // step two: connect mongoose
    return new Promise(function (resolve, reject) {
      db = mongoose.connection;
      db.on('error', reject);
      db.once('open', resolve);
    });
  },

  /**
   * Resolves with an array of entities grouped by their text. Can
   * specify a timeframe for the grouping, and can also specify the
   * number of entities to return.
   */
  aggregateEntities: function (start, end, limit) {
    return new Promise(function (resolve, reject) {
      start = start || 0;
      end = end || 9999999999999;
      limit = limit || 100;
      Entity.aggregate(
        { $match: { date: { $gte: new Date(start) , $lt: new Date(end) } } },
        { $group: { _id: {'$toLower' : '$text'}, value: { $sum: '$count'}, sentiment: { $avg: '$sentiment'} } },
        { $sort: { value: -1} },
        { $limit: limit },
        function (err, res) {
          if (err) {
            console.error(err);
            reject(err);
          } else {
            resolve(res);
          }
        }
      );
    });
  },

  /**
   * Given an entities text and a timeframe, resolve with the articles
   * that mention that entity.
   */
  getArticlesForEntity: function (entity, start, end) {
    return this.getArticleIdsForEntity(entity, start, end).then(function (articleIds) {
      return new Promise(function (resolve, reject) {
        Article.find(
          { '_id': { $in: articleIds} }, // get all articles by id
          null,                          // return all columns
          { sort: {date: -1}},           // sort by date descending and only get 100
          function(err, articles) {
            if (err) {
              console.error(err);
              reject(err);
            } else {
              resolve(articles);
            }
          }
        );
      });
    });
  },

  /**
   * Given an entities text and a timeframe, resolve with the article
   * ids that contain that entity.
   */
  getArticleIdsForEntity: function (entity, start, end) {
    return new Promise(function (resolve, reject) {
      start = start || 0;
      end = end || 9999999999999;
      Entity.aggregate(
        { $match: { text: new RegExp('^' + entity + '$', 'i'), date: { $gte: new Date(start) , $lt: new Date(end) } } },
        { $group: { _id: '$text', value: { $push: '$article_id'} } },
        function (err, res) {
          if (err) {
            console.error(err);
            reject(err);
          } else {
            resolve(res[0].value);
          }
        }
      );
    });
  },

  /**
   * Resolve with an object that contains the min and max dates in the Articles DB.
   */
  getMinAndMaxDates: function () {
    return Promise.join(this._getMinDate(), this._getMaxDate(), function (min, max) {
      return ({ min: min, max: max});
    });
  },

  /**
   * Resolve with the min date in the Articles DB.
   */
  _getMinDate: function () {
    return new Promise(function (resolve, reject) {
      Article.find({}, 'date', {limit: 1, sort: {date: 1}}, function (e, docs) {
        if (e) {
          reject(e);
        } else {
          var date = docs[0] ? docs[0].date.getTime() : null;
          resolve(date);
        }
      });
    });
  },

  /**
   * Resolve with the max date in the Articles DB.
   */
  _getMaxDate: function () {
    return new Promise(function (resolve, reject) {
      Article.find({}, 'date', {limit: 1, sort: {date: -1}}, function (e, docs) {
        if (e) {
          reject(e);
        } else {
          var date = docs[0] ? docs[0].date.getTime() : null;
          resolve(date);
        }
      });
    });
  },

  /**
   * Given an array of documents from alchemy, convert them into Articles
   * as defined in the Schema, and upload them to our database. If an article
   * with the same id exists, we update the value of what's already there.
   */
  uploadArticlesFromDocs: function (docs) {
    // ideally we could do some kind of batch operation like
    // Article.create(docs.map(this._adaptFromAlchemyDoc), function (args) {});
    // but I don't believe there's a way to do that with the upsert scheme.
    // so... until we figure that out, we'll live this method as one request per document
    docs.forEach(function (doc) {
      if (doc) {
        var articleAndEntitityPrimitives = this._adaptFromAlchemyDoc(doc);
        if (articleAndEntitityPrimitives) {
          var articlePrimitive = articleAndEntitityPrimitives.article;
          if (articlePrimitive) {
            Article.findByIdAndUpdate(articlePrimitive._id, articlePrimitive, {upsert: true}, function (args) {
              var mattdamon;
            });
          }
          var entityPrimitives = articleAndEntitityPrimitives.entities;
          if (entityPrimitives && entityPrimitives.length) {
            entityPrimitives.forEach(function (ep) {
              Entity.findByIdAndUpdate(ep._id, ep, {upsert: true}, function (args) {
                var mattdamon;
              });
            });
          }
        }
      }
    }.bind(this));
  },

  /**
   * Given a response from Alchemy, create a new Article and Entities primitives
   */
  _adaptFromAlchemyDoc: function (doc) {
    var enrichedUrl = doc.source && doc.source.enriched && doc.source.enriched.url;
    var article;
    var entities;
    if (enrichedUrl) {
      article = {
        _id: doc.id,
        title: enrichedUrl.title,
        date: new Date(doc.timestamp * 1000),
        url: enrichedUrl.url
      }
      entities = enrichedUrl.entities.map(function (e) {
        return {
          _id: e.text + doc.id,
          article_id: doc.id,
          date: new Date(doc.timestamp * 1000),
          text: e.text,
          count: e.count,
          sentiment: e.sentiment.score
        }
      }).filter(function (e) {
        return e.text.length > 1;
      });
      if (entities.length) {
        return {
          article: article,
          entities: entities
        };
      }
    }
  },

  /** Remove all articles and entities older than 30 days */
  pruneOlderThan30d: function () {
    var date = moment().startOf('day').subtract(30, 'day').unix()*1000;
    var args = { date: { $lt: new Date(date) } };
    Article.remove(args, function (e) {
      if (e) { console.error(e); }
    });
    Entity.remove(args, function (e) {
      if (e) { console.error(e); }
    });
  },

  /**
   * Remove all entities with a text length of 1
   */
  pruneCharEntities: function () {
    Entity.remove({$where:"this.text.length == 1"}, function (e) {
      if (e) {
        console.error(e);
      }
    })
  }
}

module.exports = EntitiesDB;
