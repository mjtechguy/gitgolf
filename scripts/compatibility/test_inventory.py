import copy
import unittest

import inventory


class InventoryTest(unittest.TestCase):
    def setUp(self):
        self.spec = {'swagger': '2.0', 'paths': {'/items/{id}': {
            'parameters': [{'name': 'id', 'in': 'path', 'required': True}],
            'get': {'operationId': 'readItem', 'parameters': [{'name': 'page', 'in': 'query'}], 'responses': {'200': {'schema': {'$ref': '#/definitions/Item'}}}},
            'delete': {'operationId': 'deleteItem', 'responses': {'204': {}}},
        }}, 'security': [{'token': []}]}

    def test_stable_denominator_and_fields(self):
        rows = inventory.build(self.spec, {})
        self.assertEqual(len(rows), 2)
        read = next(row for row in rows if row['id'] == 'readItem')
        self.assertEqual(read['parameters'], [{'name': 'id', 'in': 'path', 'required': True}, {'name': 'page', 'in': 'query'}])
        self.assertEqual(read['responses']['200']['schema'], {'$ref': '#/definitions/Item'})
        self.assertEqual(read['security'], [{'token': []}])
        self.assertEqual(read['assessment']['state'], 'unassessed')
        self.assertEqual(inventory.operations(self.spec), inventory.operations(copy.deepcopy(self.spec)))

    def test_reviewed_annotations_survive_and_fail_on_drift(self):
        annotation = {'state': 'missing', 'disposition': 'product', 'method': 'DELETE', 'path': '/items/{id}', 'reason': 'Missing consumer'}
        rows = inventory.build(self.spec, {'deleteItem': annotation})
        self.assertEqual(next(row for row in rows if row['id'] == 'deleteItem')['assessment'], annotation)
        with self.assertRaises(ValueError):
            inventory.build(self.spec, {'removedOperation': annotation})
        with self.assertRaises(ValueError):
            inventory.build(self.spec, {'deleteItem': dict(annotation, path='/other')})
        with self.assertRaises(ValueError):
            inventory.build(self.spec, {'deleteItem': dict(annotation, state='deployed')})
        with self.assertRaises(ValueError):
            inventory.build(self.spec, {'deleteItem': dict(annotation, complete=True)})

    def test_duplicate_ids_or_empty_spec_do_not_shrink_denominator(self):
        self.spec['paths']['/items/{id}']['delete']['operationId'] = 'readItem'
        with self.assertRaises(ValueError):
            inventory.operations(self.spec)
        with self.assertRaises(ValueError):
            inventory.operations({'swagger': '2.0', 'paths': {}})


if __name__ == '__main__':
    unittest.main()
