import unittest
from calc import add


class CalculatorTests(unittest.TestCase):
    def test_signed_numbers(self):
        for a, b, expected in [(2, 3, 5), (-2, 5, 3), (0, 0, 0)]:
            with self.subTest(a=a, b=b):
                self.assertEqual(add(a, b), expected)


if __name__ == '__main__':
    unittest.main()
