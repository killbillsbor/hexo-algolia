'use strict';

var each = require('p-each-series');
var algoliasearch = require('algoliasearch');
var crypto = require('crypto');

var CONSOLE_DEFAULTS = {
  dryRun: false,
  flush: false,
  chunkSize: 50
};

var INDEXED_PROPERTIES = [
  'title',
  'date',
  'updated',
  'slug',
  'excerpt',
  'layout'
];

function computeSha1(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

function pick(object, properties) {
  return properties.reduce(function(filteredObj, prop) {
    filteredObj[prop] = object[prop];
    return filteredObj;
  }, {});
}

function chunk(array, chunkSize) {
  var batches = [];

  while (array.length > 0) {
    batches.push(array.splice(0, chunkSize));
  }

  return batches;
}

function truncate(string, maxSize) {
	if (Buffer.byteLength(string, 'utf8') < maxSize) return string;
	const newLength = Math.min(string.length - 1000, maxSize);
	return truncate(string.substr(0, newLength), maxSize);
}

module.exports = function(args, callback) {
  var hexo = this;
  var config = Object.assign({}, hexo.config.algolia);
  var indexName = config.indexName;
  var applicationID = config.applicationID;
  var apiKey = String(process.env.HEXO_ALGOLIA_INDEXING_KEY || '');
  var client;
  var index;

  Promise.resolve(apiKey)
    .then(function(){
      if (!apiKey) {
        hexo.log.error('[Algolia] Please set an `HEXO_ALGOLIA_INDEXING_KEY` environment variable to enable content indexing.');
        hexo.log.error('>> Read %s for more informations.', 'https://npmjs.com/hexo-algolia#api-key');
        process.exit(1);
      }

      if (!indexName) {
        hexo.log.error('[Algolia] Please provide an Algolia index name in your hexo _config.yml file.');
        hexo.log.error('>> Read %s for more informations.', 'https://npmjs.com/hexo-algolia#public-facing-search-options');
        process.exit(1);
      }

      client = algoliasearch(applicationID, apiKey);
      index = client.initIndex(indexName);
    })
    .then(function(){
      hexo.log.info('[Algolia] Testing HEXO_ALGOLIA_INDEXING_KEY permissions.');

      return client.getApiKey(apiKey)
        .catch(function(err){
          hexo.log.error('[Algolia] %s', err.message);
          hexo.log.error('>> You might have used an Admin Key or an invalid Key.');
          hexo.log.error('>> Read %s for more informations.', 'https://npmjs.com/hexo-algolia#security-concerns');
          process.exit(1);
        });
    })
    .then(function() {
      return hexo.load();
    })
    .then(function() {
      var posts = hexo.database.model('Post').find({ published: true });

      return posts.toArray();
    })
    .then(function(publishedPosts) {
      var pages = hexo.database.model('Page').find({
        layout: {
          '$in': ['page']
        }
      });

      return publishedPosts.concat(pages.toArray());
    })
    .then(function(publishedPagesAndPosts) {
      return publishedPagesAndPosts.filter(item => {
				if (config.indexName === 'amplifr-static') {
					return item.path.indexOf('help') !== -1 && item.indexable !== false
				} else {
					return item.indexable !== false
        }
      })
        .map(function(data) {
        var storedPost = pick(data, INDEXED_PROPERTIES);

        storedPost.objectID = computeSha1(data.path);
        storedPost.date_as_int = Date.parse(data.date) / 1000;
        storedPost.updated_as_int = Date.parse(data.updated) / 1000;

				if (config.indexName === 'amplifr-static') {
					storedPost.permalink = data.permalink;
				} else {
					storedPost.permalink = data.permalink.replace(/\/ru\//g, '/blog/ru/')
						.replace(/\/en\//g, '/blog/en/');
				}

        if (data.categories) {
          storedPost.categories = data.categories.map(function(item) {
            return pick(item, ['name', 'path']);
          });
        }

        if (data.tags) {
          storedPost.tags = data.tags.map(function(item) {
            return pick(item, ['name', 'path']);
          });
        }

        storedPost.content = data.content.replace(/<(?:.|\n)*?>/gm, item => {
          if (item.match(/<.?em>/g) || item.match(/<.?strong>/g)) {
            return ''
          } else {
            return ' '
          }
        })
        .replace(/&nbsp;/g, ' ')
        .replace(/;/g, '; ')
        .replace(/ \./g, '.')
        .replace(/ ,/g, ',')
        .replace(/ ;/g, ';')
        .replace(/\) +;/g, ');')
        .replace(/ :/g, ':')
        .replace(/&laquo; +/g, '«')
        .replace(/&raquo; +\./g, '». ')
        .replace(/&raquo; +\,/g, '». ')
        .replace(/&raquo; +\?/g, '»? ')
        .replace(/&raquo; +\)/g, '») ')
        .replace(/ &raquo;/g, '»')
        .replace(/&rdquo; +\./g, '”. ')
        .replace(/&rdquo; +\,/g, '”. ')
        .replace(/&rdquo; +\?/g, '”? ')
        .replace(/&rdquo; +\)/g, '”) ')
        .replace(/ &rdquo;/g, '”')
        .replace(/\r?\n|\r/g, ' ')
        .replace(/ +/gm, ' ')
				.replace(/^\s+|\s+$/g, '');

				storedPost.content = truncate(storedPost.content, 19000);
        storedPost.author = data.author || config.author;
        storedPost.lang = data.lang || data.path.slice(0, 2);

        return storedPost;
      });
    })
    .then(function(publishedPagesAndPosts) {
      hexo.log.info(
        '[Algolia] Identified %d pages and posts to index.',
        publishedPagesAndPosts.length
      );

      return publishedPagesAndPosts.map(function toAlgoliaBatchActions(post) {
        return {
          action: 'updateObject',
          indexName: indexName,
          body: post
        };
      });
    })
    .then(function(actions) {
      var options = Object.assign({}, CONSOLE_DEFAULTS, args || {});

      if (options.dryRun) {
        hexo.log.info('[Algolia] Skipping due to --dry-run option');
        return;
      }

      return Promise.resolve(options.flush)
        .then(function(flush) {
          if (flush) {
            hexo.log.info('[Algolia] Clearing index...');
            return index.clearIndex();
          }
        })
        .then(function() {
          var chunks = chunk(actions, options.chunkSize);

          return each(chunks, function(chunk, i) {
            hexo.log.info(
              '[Algolia] Indexing chunk %d of %d (%d items each)',
              i + 1,
              chunks.length,
              options.chunkSize
            );

            return client
              .batch(chunk)
              .catch(function(err){
                hexo.log.error('[Algolia] %s', err.message);
              });
          });
        })

        .then(function() {
          hexo.log.info('[Algolia] Indexing done.');
        });
    })
    .catch(callback);
};
