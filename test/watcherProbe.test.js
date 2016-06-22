var
  should = require('should'),
  sinon = require('sinon'),
  proxyquire = require('proxyquire'),
  StubContext = require('./stubs/context.stub'),
  StubElasticsearch = require('./stubs/elasticsearch.stub');

require('sinon-as-promised');

describe('#watcher probes', () => {
  var
    Plugin,
    plugin,
    esStub,
    fakeContext;

  before(() => {
    esStub = new StubElasticsearch();

    Plugin = proxyquire('../lib/index', {
      'elasticsearch': {
        Client: esStub
      }
    });
  });

  beforeEach(() => {
    plugin = new Plugin();
    esStub.reset();
    fakeContext = new StubContext();
  });

  it('should initialize probes according to their configuration', () => {
    plugin.init({
      databases: ['foo'],
      storageIndex: 'bar',
      probes: {
        foo: {
          type: 'watcher',
          index: 'foo',
          collection: 'bar',
          filter: {term: { 'foo': 'bar'}},
          collects: '*',
          interval: 'none'
        },
        bar: {
          type: 'watcher',
          index: 'foo',
          collection: 'bar',
          filter: {term: { 'foo': 'bar'}},
          interval: '1m'
        },
        baz: {
          type: 'watcher',
          index: 'foo',
          collection: 'bar',
          collects: [
            'foo.bar',
            'bar.baz',
            'baz.qux'
          ]
        },
        qux: {
          type: 'watcher',
          index: 'foo',
          collection: 'bar',
          collects: []
        },
        badProbe1: {
          type: 'watcher',
          index: undefined,
          collection: 'bar',
          filter: {term: { 'foo': 'bar'}},
          collects: '*'
        },
        badProbe2: {
          type: 'watcher',
          index: 'foo',
          collection: undefined,
          filter: {term: { 'foo': 'bar'}},
          collects: '*'
        },
        badProbe3: {
          type: 'watcher',
          index: 'foo',
          collection: 'bar',
          filter: {term: { 'foo': 'bar'}},
          collects: 'foobar'
        },
        badProbe4: {
          type: 'watcher',
          index: 'foo',
          collection: 'bar',
          filter: {term: { 'foo': 'bar'}},
          collects: 123
        },
        badProbe5: {
          type: 'watcher',
          index: 'foo',
          collection: 'bar',
          filter: {term: { 'foo': 'bar'}},
          collects: { 'foo': 'bar' }
        }
      }
    }, fakeContext, false);

    should(plugin.probes.foo).not.be.empty().and.have.property('interval').undefined();
    should(plugin.probes.bar).not.be.empty().and.have.property('interval').eql(60 * 1000);
    should(plugin.probes.baz).not.be.empty().and.have.property('filter').match({});
    should(plugin.probes.qux).not.be.empty().and.have.property('collects').null();
    should(plugin.probes.badProbe1).be.undefined();
    should(plugin.probes.badProbe2).be.undefined();
    should(plugin.probes.badProbe3).be.undefined();
    should(plugin.probes.badProbe4).be.undefined();
    should(plugin.probes.badProbe5).be.undefined();
  });

  it('should initialize the measures object properly', () => {
    plugin.init({
      databases: ['foo'],
      storageIndex: 'bar',
      probes: {
        foo: {
          type: 'watcher',
          index: 'foo',
          collection: 'bar',
          collects: ['foo', 'bar']
        },
        bar: {
          type: 'watcher',
          index: 'foo',
          collection: 'bar',
          collects: '*'
        },
        baz: {
          type: 'watcher',
          index: 'foo',
          collection: 'bar'
        }
      }
    }, fakeContext, false);

    should(plugin.measures.foo).match({content: []});
    should(plugin.measures.bar).match({content: []});
    should(plugin.measures.baz).match({count: 0});
  });

  it('should save immediately if no interval is set (watcher with collected content)', (done) => {
    plugin.init({
      databases: ['foo'],
      storageIndex: 'storageIndex',
      probes: {
        fooprobe: {
          type: 'watcher',
          index: 'foo',
          collection: 'bar',
          collects: '*'
        }
      }
    }, fakeContext);

    sinon.stub(plugin.dsl, 'test').resolves(['filterId']);
    sinon.stub(plugin.client, 'bulk').resolves();
    plugin.watcher({index: 'foo', collection: 'bar', data: {body: {foo: 'bar'}}});

    setTimeout(() => {
      should(plugin.dsl.test.calledOnce).be.true();
      should(plugin.dsl.test.calledWithMatch('foo', 'bar', {foo: 'bar'}, undefined));
      should(plugin.client.bulk.calledOnce).be.true();
      should(plugin.client.bulk.firstCall.args[0]).match({
        body: [
          {index: {_index: 'storageIndex', _type: 'fooprobe'}},
          {content: {foo: 'bar'}}
        ]
      });

      plugin.client.bulk.restore();
      plugin.dsl.test.restore();

      // measure should be reset
      setTimeout(() => {
        should(plugin.measures.fooprobe.content).be.empty();
        done();
      }, 20);
    }, 20);
  });

  it('should save immediately if no interval is set (watcher counting documents)', (done) => {
    plugin.init({
      databases: ['foo'],
      storageIndex: 'storageIndex',
      probes: {
        fooprobe: {
          type: 'watcher',
          index: 'foo',
          collection: 'bar'
        }
      }
    }, fakeContext);

    sinon.stub(plugin.dsl, 'test').resolves(['filterId']);
    sinon.stub(plugin.client, 'create').resolves();
    plugin.watcher({index: 'foo', collection: 'bar', data: {body: {foo: 'bar'}}});

    setTimeout(() => {
      should(plugin.dsl.test.calledOnce).be.true();
      should(plugin.dsl.test.calledWithMatch('foo', 'bar', {foo: 'bar'}, undefined));
      should(plugin.client.create.calledOnce).be.true();
      should(plugin.client.create.firstCall.args[0]).match({
        index: 'storageIndex',
        type: 'fooprobe',
        body: {
          'count': plugin.measures.fooprobe.count
        }
      });

      plugin.client.create.restore();
      plugin.dsl.test.restore();

      // measure should be reset
      setTimeout(() => {
        should(plugin.measures.fooprobe.count).be.eql(0);
        done();
      }, 20);
    }, 0);
  });

  it('should collect the configured collectable fields', (done) => {
    var
      document = {
        _id: 'someId',
        body: {
          foobar: 'foobar',
          foo: {
            bar: 'bar',
            baz: 'baz',
            qux: 'qux'
          },
          barfoo: 'barfoo',
          quxbaz: 'quxbaz'
        }
      };

    plugin.init({
      databases: ['foo'],
      storageIndex: 'storageIndex',
      probes: {
        fooprobe: {
          type: 'watcher',
          index: 'foo',
          collection: 'bar',
          collects: ['foobar', 'foo.baz', 'foo.qux', 'barfoo']
        }
      }
    }, fakeContext);

    sinon.stub(plugin.dsl, 'test').resolves(['filterId']);
    sinon.stub(plugin.client, 'bulk').resolves();
    plugin.watcher({index: 'foo', collection: 'bar', data: document});

    setTimeout(() => {
      should(plugin.dsl.test.calledOnce).be.true();
      should(plugin.dsl.test.calledWithMatch('foo', 'bar', {foo: 'bar'}, undefined));
      should(plugin.client.bulk.calledOnce).be.true();
      should(plugin.client.bulk.firstCall.args[0]).match({
        body: [
          {index: {_index: 'storageIndex', _type: 'fooprobe'}},
          {content: {
            _id: document._id,
            foobar: 'foobar',
            foo: {
              baz: 'baz',
              qux: 'qux'
            },
            barfoo: 'barfoo'}}
        ]
      });
      should(plugin.client.bulk.firstCall.args[0].body[1].content.quxbar).be.undefined();
      should(plugin.client.bulk.firstCall.args[0].body[1].content.foo.bar).be.undefined();

      plugin.client.bulk.restore();
      plugin.dsl.test.restore();

      // measure should be reset
      setTimeout(() => {
        should(plugin.measures.fooprobe.content).be.empty();
        done();
      }, 20);
    }, 20);
  });
});